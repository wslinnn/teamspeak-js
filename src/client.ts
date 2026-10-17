import {
  type EventMap,
  type ClientOptions,
  type CommandMiddleware,
  type EventMiddleware,
  type Logger,
  type AddrResolver,
  type ClientInfo,
  type ClientUpdatedEvent,
  type DirectoryClientInfo,
  type DirectorySnapshot,
  ClientStatus,
  consoleLogger,
} from "./types.js";
import { AlreadyConnectedError } from "./errors.js";
import { Identity, Crypt } from "./crypto/index.js";
import { Resolver } from "./discovery/resolver.js";
import { PacketHandler } from "./transport/handler.js";
import { PacketType } from "./transport/packet.js";
import type { Packet } from "./transport/packet.js";
import { CommandTracker, appendReturnCode, parseServerError } from "./commands.js";
import {
  FileTransferTracker,
  buildFtInitUpload,
  buildFtInitDownload,
  uploadFileData,
  downloadFileData,
} from "./transfer.js";
import { buildCommandChain, buildEventChain } from "./events.js";
import { processInit1 } from "./handshake/crypt-handshake.js";
import { handleHandshakeInitIV, handleHandshakeExpand2, handleInitServer } from "./handshake.js";
import { handleNotification } from "./notifications.js";
import {
  applyChannelNotification,
  cloneDirectorySnapshot,
  parseDirectoryChannel,
  parseDirectoryClient,
} from "./directory.js";
import { parseCommand } from "./command/parser.js";
import { CommandThrottle } from "./throttle.js";
import { splitCommandRows, isAutoNicknameMatch } from "./helpers.js";
import type { FileUploadInfo, FileDownloadInfo } from "./types.js";
import { CommandTimeoutError, FileTransferTimeoutError, FileTransferError } from "./errors.js";
import type { Readable, Writable } from "node:stream";

export { ClientStatus };

export interface ClientState {
  status: ClientStatus;
  clid: number;
}

interface ClientInitOptions {
  readonly serverPassword: string;
  readonly defaultChannel: string;
  readonly defaultChannelPassword: string;
}

function normalizeClientInitOptions(options: ClientOptions): ClientInitOptions {
  return {
    serverPassword: options.serverPassword ?? "",
    defaultChannel: options.defaultChannel ?? "",
    defaultChannelPassword: options.defaultChannelPassword ?? "",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (arg: any) => void;

export class Client {
  // Internal — accessible from handshake.ts helpers
  /** @internal */ crypt: Crypt;
  /** @internal */ handler: PacketHandler;
  /** @internal */ logger: Logger;
  /** @internal */ nickname: string;
  /** @internal */ clid = 0;
  /** @internal */ serverHandshakeInfo: { name?: string; welcomeMessage?: string } | null = null;

  /** Server identity captured from the `initserver` connect handshake.
   *  Permission-free (the `serverinfo` command needs
   *  b_virtualserver_info_view); absent fields were absent in the handshake. */
  get serverHandshake(): { name?: string; welcomeMessage?: string } | null {
    return this.serverHandshakeInfo;
  }

  #identity: Identity;
  #addr: string;
  #resolver: AddrResolver;
  #clientInitOptions: ClientInitOptions;
  #status: ClientStatus = ClientStatus.Disconnected;
  #throttle = new CommandThrottle();
  #cmdTrack = new CommandTracker();
  #ftTrack = new FileTransferTracker();
  #clients = new Map<number, DirectoryClientInfo>();
  #channels = new Map<bigint, import("./types.js").ChannelInfo>();
  #directorySnapshotHandlers: Array<(snapshot: DirectorySnapshot) => void> = [];
  #directorySnapshotScheduled = false;
  #directorySnapshotVersion = 0;
  #connectedResolvers: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  #connectionError: Error | null = null;

  // Event handler lists
  #textMsgHandlers: Array<(msg: import("./types.js").TextMessage) => void> = [];
  #clientEnterHandlers: Array<(info: ClientInfo) => void> = [];
  #clientLeaveHandlers: Array<(evt: import("./types.js").ClientLeftViewEvent) => void> = [];
  #clientMoveHandlers: Array<(evt: import("./types.js").ClientMovedEvent) => void> = [];
  #clientUpdatedHandlers: Array<(evt: ClientUpdatedEvent) => void> = [];
  #pokedHandlers: Array<(evt: import("./types.js").PokeEvent) => void> = [];
  #voiceDataHandlers: Array<(data: import("./types.js").VoiceData) => void> = [];
  #rawNotificationHandlers: Array<(notification: import("./types.js").RawNotification) => void> = [];
  #connectedHandlers: Array<() => void> = [];
  #disconnectedHandlers: Array<(err: Error | undefined) => void> = [];
  #kickedHandlers: Array<(msg: string) => void> = [];

  // Middleware
  #cmdMiddlewares: CommandMiddleware[] = [];
  #eventMiddlewares: EventMiddleware[] = [];
  #finalCmdHandler: (cmd: string) => Promise<void>;
  #finalEvtHandler: (evt: EventMap[keyof EventMap]) => void;

  constructor(identity: Identity, addr: string, nickname: string, options: ClientOptions = {}) {
    this.#identity = identity;
    this.#addr = addr;
    this.nickname = nickname;
    this.logger = options.logger ?? consoleLogger;
    this.#resolver = options.resolver ?? new Resolver(this.logger);
    this.#clientInitOptions = normalizeClientInitOptions(options);

    this.crypt = new Crypt(identity);
    this.handler = new PacketHandler(this.crypt, this.logger);
    this.handler.onPacket = (p) => this.#handlePacket(p);
    this.handler.onClosed = (err) => this.#handleConnectionClosed(err);

    if (options.commandMiddleware) {
      this.#cmdMiddlewares.push(...options.commandMiddleware);
    }
    if (options.eventMiddleware) {
      this.#eventMiddlewares.push(...options.eventMiddleware);
    }

    this.#finalCmdHandler = this.#buildCmdHandler();
    this.#finalEvtHandler = this.#buildEvtHandler();
  }

  get status(): ClientStatus {
    return this.#status;
  }

  /** @internal */
  getClientInitOptions(): Readonly<{
    serverPassword: string;
    defaultChannel: string;
    defaultChannelPassword: string;
  }> {
    return this.#clientInitOptions;
  }

  // ---- Connection -----------------------------------------------------------

  async connect(): Promise<void> {
    if (this.#status !== ClientStatus.Disconnected) {
      throw new AlreadyConnectedError();
    }

    this.#resetForConnect();
    this.#status = ClientStatus.Connecting;

    const targetAddr = await this.#resolveAddr();
    this.logger.info("connecting to server", { address: targetAddr });
    await this.handler.connect(targetAddr);
  }

  async disconnect(): Promise<void> {
    if (this.#status === ClientStatus.Disconnected) return;

    const wasConnected = this.#status === ClientStatus.Connected;
    this.#status = ClientStatus.Disconnected;

    this.logger.info("disconnecting from server");

    if (wasConnected) {
      try {
        await this.execCommand("clientdisconnect reasonmsg=Shutdown", 1000);
      } catch {
        // best-effort
      }
    }

    this.handler.close();
    const handlers = this.#disconnectedHandlers.slice();
    for (const h of handlers) setImmediate(() => h(undefined));
  }

  waitConnected(signal?: AbortSignal): Promise<void> {
    if (this.#status === ClientStatus.Connected) return Promise.resolve();
    if (this.#connectionError) return Promise.reject(this.#connectionError);
    return new Promise<void>((resolve, reject) => {
      let waiter: { resolve: () => void; reject: (error: Error) => void };
      const onAbort = () => {
        const index = this.#connectedResolvers.indexOf(waiter);
        if (index >= 0) this.#connectedResolvers.splice(index, 1);
        const reason = signal?.reason;
        waiter.reject(reason instanceof Error ? reason : new Error(String(reason ?? "Connection wait aborted")));
      };
      waiter = {
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (error) => {
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      this.#connectedResolvers.push(waiter);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  // ---- Commands ------------------------------------------------------------

  async sendCommandNoWait(cmd: string): Promise<void> {
    await this.#throttle.wait();
    await this.#finalCmdHandler(cmd);
  }

  async execCommand(cmd: string, timeoutMs = 10_000): Promise<void> {
    await this.execCommandWithResponse(cmd, timeoutMs);
  }

  async execCommandWithResponse(
    cmd: string,
    timeoutMs = 10_000,
  ): Promise<Record<string, string>[]> {
    const [rc, promise] = this.#cmdTrack.register();
    const withRc = appendReturnCode(cmd, rc);

    try {
      await this.#throttle.wait();
      await this.#finalCmdHandler(withRc);
    } catch (err) {
      this.#cmdTrack.unregister(rc);
      throw err;
    }

    const result = await Promise.race([
      promise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new CommandTimeoutError(cmd)), timeoutMs),
      ),
    ]);

    this.#cmdTrack.unregister(rc);

    if (result.err) throw result.err;
    return result.data;
  }

  // ---- Events --------------------------------------------------------------

  on<K extends keyof EventMap>(
    event: K,
    handler: EventMap[K] extends void ? () => void : (payload: EventMap[K]) => void,
  ): this {
    switch (event) {
      case "textMessage":
        this.#textMsgHandlers.push(handler as AnyHandler);
        break;
      case "clientEnter":
        this.#clientEnterHandlers.push(handler as AnyHandler);
        break;
      case "clientLeave":
        this.#clientLeaveHandlers.push(handler as AnyHandler);
        break;
      case "clientMoved":
        this.#clientMoveHandlers.push(handler as AnyHandler);
        break;
      case "clientUpdated":
        this.#clientUpdatedHandlers.push(handler as AnyHandler);
        break;
      case "directorySnapshot":
        this.#directorySnapshotHandlers.push(handler as AnyHandler);
        break;
      case "poked":
        this.#pokedHandlers.push(handler as AnyHandler);
        break;
      case "voiceData":
        this.#voiceDataHandlers.push(handler as AnyHandler);
        break;
      case "rawNotification":
        this.#rawNotificationHandlers.push(handler as AnyHandler);
        break;
      case "connected":
        this.#connectedHandlers.push(handler as () => void);
        break;
      case "disconnected":
        this.#disconnectedHandlers.push(handler as AnyHandler);
        break;
      case "kicked":
        this.#kickedHandlers.push(handler as AnyHandler);
        break;
    }
    return this;
  }

  useCommandMiddleware(...mw: CommandMiddleware[]): this {
    this.#cmdMiddlewares.push(...mw);
    this.#finalCmdHandler = this.#buildCmdHandler();
    return this;
  }

  useEventMiddleware(...mw: EventMiddleware[]): this {
    this.#eventMiddlewares.push(...mw);
    this.#finalEvtHandler = this.#buildEvtHandler();
    return this;
  }

  // ---- API shorthand -------------------------------------------------------

  clientID(): number {
    return this.clid;
  }

  channelID(): bigint {
    const info = this.#clients.get(this.clid);
    return info?.channelID ?? 0n;
  }

  sendVoice(data: Uint8Array, codec: number): void {
    this.handler.sendVoicePacket(data, codec);
  }

  sendWhisper(data: Uint8Array, targetClientIds: number[], codec: number): void {
    this.handler.sendWhisperPacket(data, targetClientIds, codec);
  }

  // ---- File Transfer -------------------------------------------------------

  async fileTransferInitUpload(
    channelID: bigint,
    path: string,
    password: string,
    size: bigint,
    overwrite = false,
  ): Promise<FileUploadInfo> {
    const [cftid, ftPromise] = this.#ftTrack.register();
    const cmd = buildFtInitUpload(channelID, path, password, size, cftid, overwrite);

    try {
      await this.execCommand(cmd, 10_000);
    } catch (err) {
      this.#ftTrack.unregister(cftid);
      throw err;
    }

    const result = await Promise.race([
      ftPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new FileTransferTimeoutError()), 10_000),
      ),
    ]);
    this.#ftTrack.unregister(cftid);

    if ("size" in result) throw new FileTransferError("unexpected download response");
    if ("status" in result) {
      const st = result as import("./types.js").FileTransferStatusInfo;
      throw new FileTransferError(`${st.message} (status=${st.status})`);
    }
    return result as FileUploadInfo;
  }

  async fileTransferInitDownload(
    channelID: bigint,
    path: string,
    password: string,
  ): Promise<FileDownloadInfo> {
    const [cftid, ftPromise] = this.#ftTrack.register();
    const cmd = buildFtInitDownload(channelID, path, password, cftid);

    try {
      await this.execCommand(cmd, 10_000);
    } catch (err) {
      this.#ftTrack.unregister(cftid);
      throw err;
    }

    const result = await Promise.race([
      ftPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new FileTransferTimeoutError()), 10_000),
      ),
    ]);
    this.#ftTrack.unregister(cftid);

    if ("seekPosition" in result) throw new FileTransferError("unexpected upload response");
    if ("status" in result) {
      const st = result as import("./types.js").FileTransferStatusInfo;
      throw new FileTransferError(`${st.message} (status=${st.status})`);
    }
    return result as FileDownloadInfo;
  }

  uploadFileData(host: string, info: FileUploadInfo, data: Readable): Promise<void> {
    return uploadFileData(host, info, data);
  }

  downloadFileData(host: string, info: FileDownloadInfo, dest: Writable): Promise<void> {
    return downloadFileData(host, info, dest);
  }

  // ---- Internal (package-visible) ------------------------------------------

  /** @internal */
  _markConnected(): void {
    this.#status = ClientStatus.Connected;
    this.#connectionError = null;
    for (const waiter of this.#connectedResolvers) waiter.resolve();
    this.#connectedResolvers = [];
    const handlers = this.#connectedHandlers.slice();
    for (const h of handlers) setImmediate(() => h());
  }

  // ---- Private -------------------------------------------------------------

  #resetForConnect(): void {
    this.#connectionError = null;
    const staleWaiters = this.#connectedResolvers.splice(0);
    for (const waiter of staleWaiters) waiter.reject(new Error("Connection attempt was reset"));
    this.handler.close();
    this.crypt = new Crypt(this.#identity);
    this.handler = new PacketHandler(this.crypt, this.logger);
    this.handler.onPacket = (p) => this.#handlePacket(p);
    this.handler.onClosed = (err) => this.#handleConnectionClosed(err);
    this.#cmdTrack.reset();
    this.#ftTrack.reset();
    this.#channels.clear();
    this.#clients.clear();
    this.#directorySnapshotVersion++;
    this.#directorySnapshotScheduled = false;
    this.clid = 0;
    this.#finalCmdHandler = this.#buildCmdHandler();
  }

  async #resolveAddr(): Promise<string> {
    const addrWithPort = this.#addr.includes(":") ? this.#addr : `${this.#addr}:9987`;
    try {
      const resolved = await this.#resolver.resolve(this.#addr);
      return resolved[0]?.addr ?? addrWithPort;
    } catch {
      return addrWithPort;
    }
  }

  #handlePacket(p: Packet): void {
    this.#handlePacketSync(p);
  }

  #handlePacketSync(p: Packet): void {
    const pType = p.typeFlagged & 0x0f;
    if (pType === 8 /* Init1 */) {
      const response = processInit1(this.crypt, p.data);
      if (response) {
        this.handler.sendPacket(PacketType.Init1, response, 0);
      }
      return;
    }

    if ((pType === 0 /* Voice */ || pType === 1) /* VoiceWhisper */ && p.data.length > 5) {
      this.#handleVoicePacket(p.data);
      return;
    }

    if ((pType === 2 /* Command */ || pType === 3) /* CommandLow */ && p.data.length > 0) {
      this.#handleCommandLines(Buffer.from(p.data).toString("utf8"));
    }
  }

  /**
   * Parse an incoming S2C voice packet.
   * Format: [VId: u16] [CId: u16] [Codec: u8] [Data: var]
   */
  #handleVoicePacket(payload: Uint8Array): void {
    if (this.#voiceDataHandlers.length === 0) return;

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const clientId = view.getUint16(2, false);
    if (clientId === this.clid) return;

    const codec = payload[4]!;
    const data = payload.subarray(5);

    const voiceData: import("./types.js").VoiceData = { clientId, codec, data };
    for (const h of this.#voiceDataHandlers) setImmediate(() => h(voiceData));
  }

  #handleCommandLines(s: string): void {
    if (!s) return;
    const lines = s.split("\0").join("\n").split("\n");
    for (const line of lines) {
      const trimmed = line.replace(/\r$/, "");
      if (!trimmed) continue;
      for (const row of splitCommandRows(trimmed)) {
        this.#handleCommandStr(row);
      }
    }
  }

  #handleCommandStr(s: string): void {
    const cmd = parseCommand(s);
    if (!cmd || !cmd.name) return;

    if (cmd.name.startsWith("notify")) {
      const directoryChanged = applyChannelNotification(cmd.name, cmd.params, this.#channels);
      const result = handleNotification(cmd, this.clid, this.#clients, this.nickname);
      this.#processNotificationResult(result, cmd.params);
      if (directoryChanged) this.#scheduleDirectorySnapshot();
      return;
    }

    switch (cmd.name) {
      case "clientinitiv":
        handleHandshakeInitIV(this, cmd.params);
        break;
      case "initivexpand2":
        handleHandshakeExpand2(this, cmd.params);
        break;
      case "initserver":
        handleInitServer(this, cmd.params);
        break;
      case "channellist": {
        const channel = parseDirectoryChannel(cmd.params);
        if (channel) this.#channels.set(channel.id, channel);
        this.#cmdTrack.buffer(cmd.params);
        this.#scheduleDirectorySnapshot();
        break;
      }
      case "channelclientlist": {
        const client = parseDirectoryClient(cmd.params);
        if (client) this.#clients.set(client.id, client);
        this.#cmdTrack.buffer(cmd.params);
        this.#scheduleDirectorySnapshot();
        break;
      }
      case "error":
        this.#handleError(cmd.params);
        break;
      default: {
        // TS5/TS6 servers send data rows without a command-name prefix.
        // In that case our parser treats the first key=value pair as the
        // "command name" (e.g. name="clid=1827"). Reconstruct full params.
        let params = cmd.params;
        if (cmd.name.includes("=")) {
          const eqIdx = cmd.name.indexOf("=");
          const k = cmd.name.slice(0, eqIdx);
          const v = cmd.name.slice(eqIdx + 1);
          params = { [k]: v, ...cmd.params };
        }
        this.#cmdTrack.buffer(params);
        break;
      }
    }
  }

  #handleError(params: Record<string, string>): void {
    const { err, rc } = parseServerError(params);
    if (rc !== null) {
      this.#cmdTrack.resolve(rc, err);
    } else {
      // No return_code: server is acknowledging an unsolicited command
      // (welcome-sequence channellist, no-RC commands like clientupdate, etc.).
      // Discard any rows buffered since the last resolved command.
      this.#cmdTrack.discardBuffer();
    }

    // A TeamSpeak error during the welcome handshake (for example `invalid
    // parameter size` for clientinit) is the actual connection failure.
    // Preserve it for waitConnected instead of letting callers report their
    // unrelated handshake timeout.
    if (err && this.#status !== ClientStatus.Connected) {
      this.#rejectPendingConnectionWaiters(err);
    }

    const id = params["id"] ?? "0";
    if (id === "3329") {
      setImmediate(() => this.disconnect().catch(() => {}));
    }
  }

  #processNotificationResult(
    result: import("./notifications.js").NotificationResult,
    _params: Record<string, string>,
  ): void {
    switch (result.kind) {
      case "clientEnter": {
        let info = result.info;
        const current = this.#clients.get(info.id);
        if (current && info.channelID === 0n && current.channelID !== 0n) {
          info = { ...info, channelID: current.channelID };
          this.#clients.set(info.id, info);
        }
        // Our own notifycliententerview is the last event in the TS3/TS5
        // welcome sequence. It confirms command-response buffering may start
        // and — when the server renamed us over a nickname collision —
        // carries the assigned nickname. Identify self by the clid initserver
        // already assigned; never by nickname. A clientEnter from any other
        // client named "<our nick><digits>" (that client's own collision
        // rename) used to hijack this.clid, poisoning every outgoing packet
        // header with a foreign clientID until the server dropped the
        // connection for command-resend timeout.
        if (info.id !== 0 && info.id === this.clid) {
          this.nickname = info.nickname;
          this.#cmdTrack.signalWelcomeComplete();
        } else if (info.id !== 0 && this.clid === 0 && isAutoNicknameMatch(this.nickname, info.nickname)) {
          // initserver without aclid: the welcome enter is the only way to
          // learn our clid. Gate the nickname match on the clid being unknown
          // so a later "<our nick><digits>" client can never hijack an
          // established session.
          this.clid = info.id;
          this.handler.setClientID(info.id);
          this.nickname = info.nickname;
          this.#cmdTrack.signalWelcomeComplete();
        }
        this.#dispatchEvent("clientEnter", info);
        this.#scheduleDirectorySnapshot();
        break;
      }
      case "clientLeave": {
        this.#dispatchEvent("clientLeave", result.event);
        if (result.isSelf && (result.event.reasonID === 4 || result.event.reasonID === 5)) {
          const msg = result.event.reasonMsg;
          for (const h of this.#kickedHandlers) setImmediate(() => h(msg));
        }
        this.#scheduleDirectorySnapshot();
        break;
      }
      case "clientMoved":
        this.#dispatchEvent("clientMoved", result.event);
        this.#scheduleDirectorySnapshot();
        break;
      case "clientUpdated":
        this.#dispatchEvent("clientUpdated", result.event);
        this.#scheduleDirectorySnapshot();
        break;
      case "textMessage":
        this.#dispatchEvent("textMessage", result.message);
        break;
      case "poked":
        this.#dispatchEvent("poked", result.event);
        break;
      case "startUpload":
        this.#ftTrack.notify(result.info.clientFileTransferID, result.info);
        break;
      case "startDownload":
        this.#ftTrack.notify(result.info.clientFileTransferID, result.info);
        break;
      case "fileTransferStatus":
        this.#ftTrack.notify(result.info.clientFileTransferID, result.info);
        break;
      case "rawNotification":
        this.#dispatchEvent("rawNotification", result.notification);
        break;
    }
  }

  #dispatchEvent<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    this.#finalEvtHandler(payload as EventMap[keyof EventMap]);
  }

  #dispatchEventDirect<K extends keyof EventMap>(event: K, payload: EventMap[K]): void {
    switch (event) {
      case "textMessage":
        for (const h of this.#textMsgHandlers)
          setImmediate(() => h(payload as import("./types.js").TextMessage));
        break;
      case "clientEnter":
        for (const h of this.#clientEnterHandlers) setImmediate(() => h(payload as ClientInfo));
        break;
      case "clientLeave":
        for (const h of this.#clientLeaveHandlers)
          setImmediate(() => h(payload as import("./types.js").ClientLeftViewEvent));
        break;
      case "clientMoved":
        for (const h of this.#clientMoveHandlers)
          setImmediate(() => h(payload as import("./types.js").ClientMovedEvent));
        break;
      case "clientUpdated":
        for (const h of this.#clientUpdatedHandlers)
          setImmediate(() => h(payload as ClientUpdatedEvent));
        break;
      case "poked":
        for (const h of this.#pokedHandlers)
          setImmediate(() => h(payload as import("./types.js").PokeEvent));
        break;
      case "directorySnapshot":
        for (const h of this.#directorySnapshotHandlers)
          setImmediate(() => h(payload as DirectorySnapshot));
        break;
      case "rawNotification":
        for (const h of this.#rawNotificationHandlers)
          setImmediate(() => h(payload as import("./types.js").RawNotification));
        break;
    }
  }

  #handleConnectionClosed(err: Error | null): void {
    if (this.#status === ClientStatus.Disconnected) return;
    if (this.#status !== ClientStatus.Connected) {
      this.#rejectPendingConnectionWaiters(err ?? new Error("Connection closed before TeamSpeak handshake completed"));
    }
    this.#status = ClientStatus.Disconnected;
    const handlers = this.#disconnectedHandlers.slice();
    for (const h of handlers) setImmediate(() => h(err ?? undefined));
  }

  #rejectPendingConnectionWaiters(error: Error): void {
    this.#connectionError = error;
    const waiters = this.#connectedResolvers.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }

  #scheduleDirectorySnapshot(): void {
    if (this.#directorySnapshotScheduled) return;
    this.#directorySnapshotScheduled = true;
    const version = this.#directorySnapshotVersion;
    setImmediate(() => {
      this.#directorySnapshotScheduled = false;
      if (version !== this.#directorySnapshotVersion) return;
      const snapshot = cloneDirectorySnapshot(this.#channels, this.#clients);
      this.#dispatchEvent("directorySnapshot", snapshot);
    });
  }

  #buildCmdHandler(): (cmd: string) => Promise<void> {
    const base = async (cmd: string): Promise<void> => {
      this.handler.sendPacket(PacketType.Command, Buffer.from(cmd), 0);
    };
    return buildCommandChain(this.#cmdMiddlewares, base);
  }

  #buildEvtHandler(): (evt: EventMap[keyof EventMap]) => void {
    const base = (evt: EventMap[keyof EventMap]): void => {
      // Determine which event type this is by checking the shape
      if (
        evt !== null &&
        evt !== undefined &&
        typeof evt === "object" &&
        "channels" in evt &&
        "clients" in evt
      ) {
        this.#dispatchEventDirect("directorySnapshot", evt as EventMap["directorySnapshot"]);
      } else if (
        evt !== null &&
        evt !== undefined &&
        typeof evt === "object" &&
        "name" in evt &&
        "params" in evt &&
        typeof evt.name === "string"
      ) {
        this.#dispatchEventDirect("rawNotification", evt as EventMap["rawNotification"]);
      } else if (
        evt !== null &&
        evt !== undefined &&
        typeof evt === "object" &&
        "invokerName" in evt &&
        "message" in evt &&
        "targetMode" in evt
      ) {
        this.#dispatchEventDirect("textMessage", evt as EventMap["textMessage"]);
      } else if (
        evt !== null &&
        evt !== undefined &&
        typeof evt === "object" &&
        "invokerName" in evt &&
        "message" in evt &&
        !("targetMode" in evt)
      ) {
        this.#dispatchEventDirect("poked", evt as EventMap["poked"]);
      } else if (
        evt !== null &&
        evt !== undefined &&
        typeof evt === "object" &&
        "info" in evt &&
        evt.info !== null &&
        typeof evt.info === "object" &&
        "id" in evt.info &&
        "uid" in evt.info
      ) {
        this.#dispatchEventDirect("clientUpdated", evt as EventMap["clientUpdated"]);
      } else if (
        evt !== null &&
        evt !== undefined &&
        typeof evt === "object" &&
        "id" in evt &&
        "uid" in evt
      ) {
        this.#dispatchEventDirect("clientEnter", evt as EventMap["clientEnter"]);
      } else if (
        evt !== null &&
        evt !== undefined &&
        typeof evt === "object" &&
        "id" in evt &&
        "reasonID" in evt &&
        "targetChannelID" in evt
      ) {
        this.#dispatchEventDirect("clientMoved", evt as EventMap["clientMoved"]);
      } else if (
        evt !== null &&
        evt !== undefined &&
        typeof evt === "object" &&
        "id" in evt &&
        "reasonID" in evt
      ) {
        this.#dispatchEventDirect("clientLeave", evt as EventMap["clientLeave"]);
      }
    };
    return buildEventChain(this.#eventMiddlewares, base);
  }
}
