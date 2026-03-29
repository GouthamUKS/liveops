import NodeMediaServer from 'node-media-server';

export function createRtmpServer(): NodeMediaServer {
  const nms = new NodeMediaServer({
    rtmp: {
      port: 1935,
      chunk_size: 60000,
      gop_cache: true,
      ping: 30,
      ping_timeout: 60,
    },
    // Suppress node-media-server's own verbose logging
    logType: 0,
  });

  return nms;
}
