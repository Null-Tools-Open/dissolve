import { isMainThread, parentPort, workerData } from 'worker_threads';
import { ImageCompressor } from '../compressors/imageCompressor';
import { VideoCompressor } from '../compressors/videoCompressor';
import path from 'path';

interface FragmentTask {
  buffer: Buffer;
  fragmentIndex: number;
  totalFragments: number;
  originalFile: string;
  ext?: string;
}

interface WorkerPayload {
  files: Array<string | FragmentTask>;
  options: Record<string, any>;
  workerIndex: number;
  ffmpegPath?: string;
  ffprobePath?: string;
  isLimited?: boolean;
  hasFFprobe?: boolean;
}

if (!isMainThread) {
  const payload = workerData as WorkerPayload;

  async function processChunk(): Promise<void> {
    try {
      const {
        files,
        options,
        workerIndex,
        ffmpegPath,
        ffprobePath,
        isLimited,
        hasFFprobe
      } = payload;

      const imageCompressor = new ImageCompressor({
        ...options,
        speedOptimized: options.ultrafast || false,
        skipOptimizations: options.noOptimize || false
      });

      const videoCompressor = new VideoCompressor({
        ...options,
        speedOptimized: options.ultrafast || false,
        skipOptimizations: options.noOptimize || false,
        ffmpegPath,
        ffprobePath,
        isLimited,
        hasFFprobe
      });

      const results: any[] = [];

      for (const file of files) {
        try {
          const startTime = Date.now();
          const isFragment = typeof file !== 'string';
          let result: any;

          if (isFragment && file.buffer && file.originalFile) {
            result = await imageCompressor.compress(file.buffer, options);
            result.fragmentIndex = file.fragmentIndex;
            result.totalFragments = file.totalFragments;
            result.originalFile = file.originalFile;
          } else if (typeof file === 'string') {
            const isImage = /(jpg|jpeg|png|webp|avif|bmp|tiff)$/i.test(file);
            const isVideo = /(mp4|avi|mov|mkv|webm|flv|wmv)$/i.test(file);

            if (isImage) {
              result = await imageCompressor.compress(file, options);
            } else if (isVideo) {
              result = await videoCompressor.compress(file, options);
            } else {
              throw new Error(`Unsupported file type: ${path.extname(file)}`);
            }
          } else {
            throw new Error('Unknown task payload received by worker');
          }

          const processingTime = Date.now() - startTime;

          results.push({
            ...result,
            processingTime,
            workerIndex,
            success: true
          });

          parentPort?.postMessage({
            type: 'progress',
            file:
              typeof file === 'string'
                ? path.basename(file)
                : `${path.basename(file.originalFile)}[fragment ${file.fragmentIndex + 1}/${file.totalFragments}]`,
            result,
            workerIndex
          });
        } catch (error: any) {
          const fragment = typeof file === 'string' ? null : file;
          results.push({
            file: fragment ? fragment.originalFile : file,
            error: error?.message ?? String(error),
            workerIndex,
            success: false
          });

          parentPort?.postMessage({
            type: 'error',
            file: fragment
              ? `${path.basename(fragment.originalFile)}[fragment ${fragment.fragmentIndex + 1}/${fragment.totalFragments}]`
              : path.basename(file as string),
            error: error?.message ?? String(error),
            workerIndex
          });
        }
      }

      parentPort?.postMessage({
        type: 'complete',
        results,
        workerIndex
      });
    } catch (error: any) {
      parentPort?.postMessage({
        type: 'worker_error',
        error: error?.message ?? String(error),
        workerIndex: payload.workerIndex
      });
    }
  }

  void processChunk();
}

export {};