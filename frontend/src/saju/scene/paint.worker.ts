import { detailData, foamData } from './ocean/seaTiles';
import type { PaintJob, PaintReply } from './painter';
import { paintSurface } from './surfaceRecipes';

// A painter (see painter): paints the tiles it is asked for, one at a time, and sends each back as it is done.

/** The worker's own side of its channel (the page's lib has no worker scope). */
const scope = self as unknown as { onmessage: ((event: MessageEvent<PaintJob>) => void) | null; postMessage: (message: PaintReply, transfer: Transferable[]) => void };

scope.onmessage = ({ data: { key, request } }: MessageEvent<PaintJob>) => {
  let reply: PaintReply;
  try {
    if (request.kind === 'surface') {
      const { colors, normals } = paintSurface(request.surface);
      reply = { key, data: [colors, normals] };
    } else if (request.kind === 'foam') {
      reply = { key, data: [foamData()] };
    } else {
      reply = { key, data: [detailData(request.windAngle)] };
    }
  } catch (error) {
    reply = { key, failed: error instanceof Error ? error.message : String(error) };
  }
  scope.postMessage(reply, (reply.data ?? []).map((array) => array.buffer as ArrayBuffer));
};
