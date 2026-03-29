declare module 'node-media-server' {
  interface NodeMediaServerConfig {
    rtmp?: {
      port?: number;
      chunk_size?: number;
      gop_cache?: boolean;
      ping?: number;
      ping_timeout?: number;
    };
    http?: {
      port?: number;
      allow_origin?: string;
    };
    logType?: number;
  }

  class NodeMediaServer {
    constructor(config: NodeMediaServerConfig);
    run(): void;
    stop(): void;
    on(
      event:
        | 'preConnect'
        | 'postConnect'
        | 'doneConnect'
        | 'prePublish'
        | 'postPublish'
        | 'donePublish'
        | 'prePlay'
        | 'postPlay'
        | 'donePlay',
      listener: (id: string, streamPath: string, args: Record<string, unknown>) => void
    ): void;
  }

  export = NodeMediaServer;
}
