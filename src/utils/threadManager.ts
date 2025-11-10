const { Worker } = require('worker_threads');
const os = require('os');
const path = require('path');
const shcl = require('@impulsedev/shcl');

type ThreadManagerOptions = Record<string, any>;

class ThreadManager {
  [key: string]: any;
  private options: ThreadManagerOptions;
  private workers: any[];
  private isQuiet: boolean;
  private threadCount!: number;

  constructor(options: ThreadManagerOptions = {}) {
    this.options = options;
    this.workers = [];
    this.isQuiet = options.skip || false;
    
    this.calculateOptimalThreads();
  }
  
  calculateOptimalThreads() {
    const totalCores = os.cpus().length;
    
    if (this.options.threads) {
      const baseThreads = parseInt(this.options.threads);
      if (this.options.ultrafast) {
        this.threadCount = Math.max(2, Math.min(Math.ceil(baseThreads * 1.5), 32));
      } else {
        this.threadCount = Math.max(2, Math.min(baseThreads, 32));
      }
    } else if (this.options.ultrafast) {
      this.threadCount = Math.max(2, Math.min(totalCores * 2, 32));
    } else {
      this.threadCount = Math.max(2, Math.min(Math.ceil(totalCores * 1.5), 32));
    }
    
    if (!this.isQuiet) {
      console.log(shcl.gray(`Thread Manager: ${totalCores} CPU cores detected`));
      if (this.options.threads && this.options.ultrafast) {
        console.log(shcl.gray(`Using ${this.threadCount} worker threads (1.5x specified threads, ultrafast mode)`));
      } else if (this.options.threads) {
        console.log(shcl.gray(`Using ${this.threadCount} worker threads (specified threads)`));
      } else if (this.options.ultrafast) {
        console.log(shcl.gray(`Using ${this.threadCount} worker threads (2x per core, ultrafast mode)`));
      } else {
        console.log(shcl.gray(`Using ${this.threadCount} worker threads (1.5x per core)`));
      }
    }
      if (this.threadCount > totalCores * 2) {
        console.log(shcl.yellow(`Warning: High thread count detected (${this.threadCount} workers > ${totalCores * 2} optimal)`));
    }
  }
  
  chunkFiles(files) {
    const chunks = [];
    const filesPerWorker = Math.ceil(files.length / this.threadCount);
    
    for (let i = 0; i < this.threadCount && i * filesPerWorker < files.length; i++) {
      const start = i * filesPerWorker;
      const end = Math.min(start + filesPerWorker, files.length);
      const chunk = files.slice(start, end);
      
      if (chunk.length > 0) {
        chunks.push({
          files: chunk,
          workerIndex: i
        });
      }
    }
    
    if (!this.isQuiet) {
      console.log(shcl.gray(`Split ${files.length} files into ${chunks.length} chunks`));
    }
    
    return chunks;
  }
  
  async processFiles(files: any[], options: ThreadManagerOptions = {}) {
    if (files.length === 0) {
      return { processed: 0, errors: [], totalSizeReduction: 0, files: [] };
    }
    
    let filesToProcess = files;
    if (options.forceThreads) {
      const { splitLargeImagesIntoFragments } = require('./threadManagerFragmentation');
      filesToProcess = await splitLargeImagesIntoFragments(files, this.threadCount, options);
    }

    if (filesToProcess.length < 4 && !options.forceThreads) {
      if (!this.isQuiet) {
        console.log(shcl.gray(`Using single thread for ${filesToProcess.length} files (overhead optimization)`));
      }
      return this.processSingleThreaded(filesToProcess, options);
    }
    
    const chunks = this.chunkFiles(filesToProcess);
    const results = {
      processed: 0,
      errors: [],
      totalSizeReduction: 0,
      processingTimes: [],
      files: []
    };
    
    if (!this.isQuiet) {
      console.log(shcl.cyan(`Starting multi-threaded compression with ${chunks.length} workers...`));
    }
    
    try {
      await this.executeWorkers(chunks, options, results);
    } catch (error) {
      if (!this.isQuiet) {
        console.error(shcl.red(`Thread manager error: ${error.message}`));
      }
      throw error;
    } finally {
      await this.cleanup();
    }
    return results;
  }
  
  async executeWorkers(chunks, options, results) {
    const workerPromises = chunks.map((chunk, index) => {
      return this.createWorker(chunk, options, results);
    });
    
    await Promise.all(workerPromises);
  }
  
  createWorker(chunk, options, results) {
    return new Promise((resolve, reject) => {
      const workerPath = path.join(__dirname, '../workers/compressionWorker.js');
      let ffmpegPath = null, ffprobePath = null, isLimited = false, hasFFprobe = false;
      const hasVideo = chunk.files.some(f => typeof f === 'string' && /\.(mp4|avi|mov|mkv|webm|flv|wmv)$/i.test(f));
      if (hasVideo) {
        const { VideoCompressor } = require('../compressors/videoCompressor');
        const ffmpegPaths = VideoCompressor.detectFFmpegPaths();
        ffmpegPath = ffmpegPaths.ffmpegPath;
        ffprobePath = ffmpegPaths.ffprobePath;
        isLimited = ffmpegPaths.isLimited;
        hasFFprobe = ffmpegPaths.hasFFprobe;
      }
      const worker = new Worker(workerPath, {
        workerData: {
          files: chunk.files,
          options: { ...this.options, ...options },
          workerIndex: chunk.workerIndex,
          ffmpegPath,
          ffprobePath,
          isLimited,
          hasFFprobe
        }
      });
      
      this.workers.push(worker);
      
      worker.on('message', (message) => {
        switch (message.type) {
          case 'progress':
            if (!this.isQuiet) {
              const reduction = ((message.result.originalSize - message.result.compressedSize) / message.result.originalSize * 100).toFixed(1);
              console.log(
                shcl.green(`[W${message.workerIndex}]`) +
                ` ${message.file} ` +
                shcl.gray(`-${reduction}%`)
              );
            }
            break;
            
          case 'error':
            results.errors.push({
              file: message.file,
              error: message.error,
              worker: message.workerIndex
            });
            if (!this.isQuiet) {
              console.log(shcl.red(`[W${message.workerIndex}]`) + ` ${message.file} - ${message.error}`);
            }
            break;
            
          case 'complete':
            message.results.forEach(result => {
              if (result.success) {
                results.processed++;
                results.totalSizeReduction += (result.originalSize - result.compressedSize);
                results.processingTimes.push(result.processingTime);
                if (result.outputFile) {
                  results.files.push({
                    inputFile: result.inputFile,
                    outputFile: result.outputFile
                  });
                }
              }
            });
            resolve(undefined);
            break;
            
          case 'worker_error':
            reject(new Error(`Worker ${message.workerIndex} failed: ${message.error}`));
            break;
        }
      });
      
      worker.on('error', (error) => {
        reject(new Error(`Worker ${chunk.workerIndex} error: ${error.message}`));
      });
      
      worker.on('exit', (code) => {
        if (code !== 0) {
          reject(new Error(`Worker ${chunk.workerIndex} exited with code ${code}`));
        }
      });
    });
  }
  
  async processSingleThreaded(files: any[], options: ThreadManagerOptions): Promise<any> {
    const { ImageCompressor } = require('../compressors/imageCompressor');
    const mime = require('mime-types');
    
    const imageCompressor = new ImageCompressor({
      ...this.options,
      ...options,
      speedOptimized: options.ultrafast || false,
      skipOptimizations: options.noOptimize || false
    });
    
    let videoCompressor = null;
    const hasVideo = files.some(f => {
      const mimeType = mime.lookup(f);
      return mimeType && mimeType.startsWith('video/');
    });
    
    if (hasVideo) {
      const { VideoCompressor } = require('../compressors/videoCompressor');
      videoCompressor = new VideoCompressor({
        ...this.options,
        ...options,
        speedOptimized: options.ultrafast || false,
        skipOptimizations: options.noOptimize || false
      });
    }
    
    const results = {
      processed: 0,
      errors: [],
      totalSizeReduction: 0,
      processingTimes: [],
      files: []
    };
    
    for (const file of files) {
      try {
        const startTime = Date.now();
        const mimeType = mime.lookup(file);
        
        let result;
        if (mimeType && mimeType.startsWith('image/')) {
          result = await imageCompressor.compress(file, options);
        } else if (mimeType && mimeType.startsWith('video/')) {
          if (videoCompressor) {
            result = await videoCompressor.compress(file, options);
          } else {
            throw new Error('VideoCompressor not available for video file');
          }
        } else {
          throw new Error(`Unsupported file type: ${mimeType || 'unknown'}`);
        }
        
        const processingTime = Date.now() - startTime;
        
        results.processed++;
        results.totalSizeReduction += (result.originalSize - result.compressedSize);
        results.processingTimes.push(processingTime);
        
        if (result.outputFile) {
          results.files.push({
            inputFile: result.inputFile,
            outputFile: result.outputFile
          });
        }
        
        if (!this.isQuiet) {
          const reduction = ((result.originalSize - result.compressedSize) / result.originalSize * 100).toFixed(1);
          console.log(
            shcl.green(`✓`) +
            ` ${path.basename(file)} ` +
            shcl.gray(`-${reduction}%`)
          );
        }
        
      } catch (error) {
        results.errors.push({
          file,
          error: error.message
        });
        
        if (!this.isQuiet) {
          console.log(shcl.red(`✗`) + ` ${path.basename(file)} - ${error.message}`);
        }
      }
    }
    
    return results;
  }
  
  async cleanup() {
    const terminationPromises = this.workers.map(worker => {
      return worker.terminate();
    });
    
    await Promise.all(terminationPromises);
    this.workers = [];
  }
}

export { ThreadManager };