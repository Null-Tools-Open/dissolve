const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { ImageCompressor } = require('../compressors/imageCompressor');
const { VideoCompressor } = require('../compressors/videoCompressor');
const fs = require('fs').promises;
const path = require('path');

if (!isMainThread) {
  async function processChunk() {
    try {
      const { files, options, workerIndex } = workerData;
      
      const imageCompressor = new ImageCompressor({
        ...options,
        speedOptimized: options.ultrafast || false,
        skipOptimizations: options.noOptimize || false
      });
      
      const videoCompressor = new VideoCompressor({
        ...options,
        speedOptimized: options.ultrafast || false,
        skipOptimizations: options.noOptimize || false,
        ffmpegPath: workerData.ffmpegPath,
        ffprobePath: workerData.ffprobePath,
        isLimited: workerData.isLimited,
        hasFFprobe: workerData.hasFFprobe
      });
      
      const results = [];
      
      for (const file of files) {
        try {
          const startTime = Date.now();
          
          let result;
          if (file && file.buffer && file.originalFile) {
            result = await imageCompressor.compress(file.buffer, options);
            result.fragmentIndex = file.fragmentIndex;
            result.totalFragments = file.totalFragments;
            result.originalFile = file.originalFile;
          } else {
            const isImage = /\.(jpg|jpeg|png|webp|avif|bmp|tiff)$/i.test(file);
            const isVideo = /\.(mp4|avi|mov|mkv|webm|flv|wmv)$/i.test(file);
          if (isImage) {
            result = await imageCompressor.compress(file, options);
          } else if (isVideo) {
            result = await videoCompressor.compress(file, options);
          } else {
              throw new Error(`Unsupported file type: ${typeof file === 'string' ? path.extname(file) : 'fragment'}`);
            }
          }
          
          const processingTime = Date.now() - startTime;
          
          results.push({
            ...result,
            processingTime,
            workerIndex,
            success: true
          });
          
          parentPort.postMessage({
            type: 'progress',
            file: typeof file === 'string' ? path.basename(file) : `${path.basename(file.originalFile)}[fragment ${file.fragmentIndex+1}/${file.totalFragments}]`,
            result,
            workerIndex
          });
          
        } catch (error) {
          results.push({
            file: typeof file === 'string' ? file : file.originalFile,
            error: error.message,
            workerIndex,
            success: false
          });
          
          parentPort.postMessage({
            type: 'error',
            file: typeof file === 'string' ? path.basename(file) : `${path.basename(file.originalFile)}[fragment ${file.fragmentIndex+1}/${file.totalFragments}]`,
            error: error.message,
            workerIndex
          });
        }
      }
      
      parentPort.postMessage({
        type: 'complete',
        results,
        workerIndex
      });
      
    } catch (error) {
      parentPort.postMessage({
        type: 'worker_error',
        error: error.message,
        workerIndex: workerData.workerIndex
      });
    }
  }
  
  processChunk();
}

module.exports = { Worker };