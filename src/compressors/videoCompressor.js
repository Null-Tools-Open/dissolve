const path = require('path');
const fs = require('fs').promises;
const { FileUtils } = require('../utils/fileUtils');
const { spawnSync } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');

class VideoCompressor {
  constructor(options = {}) {
    this.options = options;
    this.speedOptimized = options.speedOptimized || false;
    this.skipOptimizations = options.skipOptimizations || false;
    this.ffmpegPath = options.ffmpegPath || null;
    this.ffprobePath = options.ffprobePath || null;
    this.isFFmpegLimited = options.isLimited || false;
    this.hasFFprobe = options.hasFFprobe !== undefined ? options.hasFFprobe : false;
    
    if (!this.ffmpegPath) {
      this.setupFFmpegPaths();
    } else {
      ffmpeg.setFfmpegPath(this.ffmpegPath);
      if (this.ffprobePath && this.hasFFprobe) {
        ffmpeg.setFfprobePath(this.ffprobePath);
      }
      if (!this.options.skip) {
        console.log(`FFmpeg configured via options: ${this.ffmpegPath}`);
        if (this.isFFmpegLimited) {
          console.log(`Using limited FFmpeg version (${this.hasFFprobe ? 'with' : 'without'} ffprobe), using compatible codecs.`);
        }
      }
    }
  }

  setupFFmpegPaths() {
    try {
      const currentFFmpegPath = require('fluent-ffmpeg')().options.ffmpeg_path || null;
      if (currentFFmpegPath) {
        this.ffmpegPath = currentFFmpegPath;
        try {
          const currentFFprobePath = require('fluent-ffmpeg')().options.ffprobe_path || null;
          this.ffprobePath = currentFFprobePath;
          this.hasFFprobe = !!currentFFprobePath;
        } catch (e) {
          this.ffprobePath = null;
          this.hasFFprobe = false;
        }
        this.isFFmpegLimited = currentFFmpegPath.toLowerCase().includes('steelseries') || 
                              currentFFmpegPath.toLowerCase().includes('gg-');
        if (!this.options.skip) {
          console.log(`FFmpeg already configured: ${currentFFmpegPath}`);
          if (this.isFFmpegLimited) {
            console.log(`Detected limited FFmpeg version (${this.hasFFprobe ? 'with' : 'without'} ffprobe), using compatible codecs.`);
          }
        }
        return;
      }
    } catch (e) {
    }

    try {
      const { ffmpegPath, ffprobePath, isLimited, hasFFprobe, detectionSource } = VideoCompressor.detectFFmpegPaths();
      if (ffmpegPath) {
        ffmpeg.setFfmpegPath(ffmpegPath);
        if (ffprobePath && hasFFprobe) {
          ffmpeg.setFfprobePath(ffprobePath);
        }
        this.ffmpegPath = ffmpegPath;
        this.ffprobePath = ffprobePath;
        this.isFFmpegLimited = isLimited;
        this.hasFFprobe = hasFFprobe;
        if (!this.options.skip) {
          console.log(`FFmpeg detected via ${detectionSource}: ${ffmpegPath}`);
          if (isLimited) {
            console.log(`Detected limited FFmpeg version (${hasFFprobe ? 'with' : 'without'} ffprobe), using compatible codecs.`);
          }
        }
      } else {
        const errorMessage = `FFmpeg/ffprobe not found in PATH or common locations. Please install FFmpeg to process video files.\nDownload from: https://ffmpeg.org/download.html\nOr install via package manager:\n- Windows: choco install ffmpeg / scoop install ffmpeg\n- macOS: brew install ffmpeg\n- Linux: sudo apt install ffmpeg (Debian/Ubuntu) / sudo dnf install ffmpeg (Fedora)`;
        if (!this.options.skip) {
          console.error(`Fatal Error: ${errorMessage}`);
        }
        throw new Error(errorMessage);
      }
    } catch (error) {
      throw error;
    }
  }

  async compress(inputFile, options = {}) {
    this.setupFFmpegPaths();
    const originalStats = await fs.stat(inputFile);
    const originalSize = originalStats.size;
    const outputPath = this.generateOutputPath(inputFile, options);
    const metadata = await this.getVideoMetadata(inputFile);
    let finalOutputPath = outputPath;
    if (options.targetSize) {
      const targetBytes = typeof options.targetSize === 'string' ? 
        this.parseTargetSize(options.targetSize) : 
        options.targetSize;
      
      if ((targetBytes / originalSize) < 0.15) {
        finalOutputPath = await this.extremeCompressionStrategy(inputFile, outputPath, metadata, options, originalSize, targetBytes);
      } else {
        finalOutputPath = await this.standardCompressionStrategy(inputFile, outputPath, metadata, options, originalSize, targetBytes);
      }
    } else {
      const ffmpegCommand = this.createFFmpegCommand(inputFile, outputPath, metadata, options);
      await this.executeCompression(ffmpegCommand);
    }
    const compressedStats = await fs.stat(finalOutputPath);
    const compressedSize = compressedStats.size;
    return {
      inputFile,
      outputFile: finalOutputPath,
      originalSize,
      compressedSize,
      reduction: ((originalSize - compressedSize) / originalSize * 100).toFixed(2),
      metadata: {
        duration: metadata.format?.duration,
        bitrate: metadata.format?.bit_rate,
        size: metadata.format?.size,
        codec: metadata.streams?.[0]?.codec_name,
        resolution: `${metadata.streams?.[0]?.width}x${metadata.streams?.[0]?.height}`
      }
    };
  }

  createFFmpegCommand(inputFile, outputPath, metadata, options) {
    let command = require('fluent-ffmpeg')(inputFile);
    const codec = options.codec || 'h264';
    command = command.videoCodec(this.getVideoCodec(codec));
    command = command.audioCodec(this.getAudioCodec());
    
    if (options.bitrate) {
      command = command.videoBitrate(options.bitrate);
    } else {
      let quality = options.quality || 'medium';
      
      if (typeof quality === 'number' || (typeof quality === 'string' && !isNaN(quality))) {
        const numQuality = parseInt(quality);
        if (numQuality >= 90) quality = 'high';
        else if (numQuality >= 75) quality = 'slow';
        else if (numQuality >= 60) quality = 'medium';
        else if (numQuality >= 40) quality = 'fast';
        else quality = 'ultrafast';
      }
      
      if (this.speedOptimized && !options.quality) {
        quality = 'ultrafast';
      }
      
      command = this.applyQualitySettings(command, quality, codec);
    }
    
    if (options.width && options.height) {
      command = command.size(`${options.width}x${options.height}`);
    } else if (options.width || options.height) {
      const currentWidth = metadata.streams?.[0]?.width || 1920;
      const currentHeight = metadata.streams?.[0]?.height || 1080;
      const aspectRatio = currentWidth / currentHeight;
      
      if (options.width) {
        const newHeight = Math.round(options.width / aspectRatio);
        command = command.size(`${options.width}x${newHeight}`);
      } else {
        const newWidth = Math.round(options.height * aspectRatio);
        command = command.size(`${newWidth}x${options.height}`);
      }
    }

    if (!this.isFFmpegLimited) {
      let preset = 'fast';
      if (this.speedOptimized) {
        preset = 'ultrafast';
      } else if (options.quality && parseInt(options.quality) >= 90) {
        preset = 'slow';
      }
      command = command.addOption('-preset', preset);
    } else if (this.speedOptimized) {
      command = command.addOption('-rc', 'constqp');
    }
    
    command = command
      .addOption('-movflags', this.skipOptimizations ? '' : 'faststart')
      .addOption('-pix_fmt', 'yuv420p')
      .addOption('-threads', options.threads || '0');
      
    if (this.speedOptimized) {
      command = command
        .addOption('-tune', 'zerolatency');
    }
    
    const outputFormat = this.getOutputFormat(outputPath);
    if (outputFormat === 'mp4') {
      command = command
        .addOption('-f', 'mp4')
        .addOption('-avoid_negative_ts', 'make_zero');
    }
    
    return command.output(outputPath);
  }

  applyQualitySettings(command, quality, codec) {
    if (this.isFFmpegLimited) {
      const bitrates = {
        'ultrafast': '800k',
        'fast': '1200k',
        'medium': '1800k',
        'slow': '2500k',
        'high': '4000k'
      };
      command = command.videoBitrate(bitrates[quality] || bitrates.medium);
      return command;
    }
    const settings = {
      'ultrafast': { crf: 30, preset: 'ultrafast' },
      'fast': { crf: 26, preset: 'fast' },
      'medium': { crf: 23, preset: 'medium' },
      'slow': { crf: 20, preset: 'slow' },
      'high': { crf: 18, preset: 'veryslow' }
    };
    const setting = settings[quality] || settings.medium;
    if (codec === 'h264' || codec === 'h265') {
      command = command.addOption('-crf', setting.crf.toString());
      if (!this.isFFmpegLimited) {
        command = command.addOption('-preset', setting.preset);
      }
      if (codec === 'h265') {
        command = command.addOption('-x265-params', 'log-level=error');
      }
    } else if (codec === 'av1') {
      command = command.addOption('-cpu-used', '8');
    } else {
      const bitrates = {
        'ultrafast': '800k',
        'fast': '1200k',
        'medium': '1800k',
        'slow': '2500k',
        'high': '4000k'
      };
      command = command.videoBitrate(bitrates[quality] || bitrates.medium);
    }
    return command;
  }

  getVideoCodec(codec) {
    if (this.isFFmpegLimited) {
      const limitedCodecMap = {
        'h264': 'h264_nvenc',
        'h265': 'h264_nvenc',
        'hevc': 'h264_nvenc',
        'vp9': 'h264_nvenc',
        'vp8': 'h264_nvenc',
        'av1': 'h264_nvenc'
      };
      return limitedCodecMap[codec.toLowerCase()] || 'h264_nvenc';
    }
    const codecMap = {
      'h264': 'libx264',
      'h265': 'libx265',
      'hevc': 'libx265',
      'vp9': 'libvpx-vp9',
      'vp8': 'libvpx',
      'av1': 'libaom-av1'
    };
    return codecMap[codec.toLowerCase()] || 'libx264';
  }

  getAudioCodec() {
    return this.isFFmpegLimited ? 'aac_mf' : 'aac';
  }

  async getVideoMetadata(inputFile) {
    this.setupFFmpegPaths();
    
    if (!this.hasFFprobe) {
      return {
        format: {
          duration: 60,
          bit_rate: '2000000',
          size: 1000000
        },
        streams: [{
          codec_name: 'h264',
          width: 1920,
          height: 1080
        }]
      };
    }

    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputFile, (err, metadata) => {
        if (err) {
          reject(new Error(`FFmpeg error: ${err.message}`));
        } else {
          resolve(metadata);
        }
      });
    });
  }

  async extremeCompressionStrategy(inputFile, outputPath, metadata, options, originalSize, targetSize) {
    if (!this.options.skip) {
      console.log('Extreme video compression mode: testing strategies sequentially...');
    }
    
    const duration = metadata.format?.duration || 60;
    const width = metadata.streams?.[0]?.width || 1920;
    const height = metadata.streams?.[0]?.height || 1080;
    const isLargeVideo = width > 2560 || height > 1440;
    
    if (options.forceThreads && !this.options.skip) {
      return await this.parallelExtremeCompressionStrategy(inputFile, outputPath, metadata, options, originalSize, targetSize);
    }
    
    let strategies = [];
    
    if (this.isFFmpegLimited) {
      const resolutions = isLargeVideo ? [0.5, 0.3, 0.2] : [1.0, 0.7, 0.5];
      const bitrates = isLargeVideo ? ['400k', '200k', '100k'] : ['800k', '600k', '400k', '200k'];
      const codecs = ['h264_nvenc'];
      
      for (const codec of codecs) {
        for (const bitrate of bitrates) {
          for (const scale of resolutions) {
            strategies.push({ codec, bitrate, scale, preset: 'fast' });
          }
        }
      }
    } else {
      const resolutions = isLargeVideo ? [0.3, 0.2, 0.1] : [0.7, 0.5, 0.3];
      const crfs = isLargeVideo ? [36, 40, 45] : [28, 32, 36];
      const presets = ['fast'];
      const codecs = ['h264'];
      
      for (const codec of codecs) {
        for (const preset of presets) {
          for (const crf of crfs) {
            for (const scale of resolutions) {
              strategies.push({ codec, preset, crf, scale });
            }
          }
        }
      }
    }
    
    if (!this.options.skip && isLargeVideo) {
      console.log(`Large video detected (${width}x${height}) - using conservative settings`);
    }
    
    let bestResult = null;
    const baseName = path.basename(inputFile, path.extname(inputFile));
    
    for (let i = 0; i < strategies.length; i++) {
      const s = strategies[i];
      
      const tempOut = outputPath.replace(/\.[^.]+$/, `_extreme_${i}.mp4`);
      
      if (!this.options.skip) {
        console.log(`Testing strategy ${i+1}/${strategies.length}: ${s.codec} ${s.crf ? `CRF${s.crf}` : s.bitrate} ${s.preset} ${(s.scale*100)}%`);
      }
      
      const scaledWidth = Math.round(width * s.scale);
      const scaledHeight = Math.round(height * s.scale);
      const totalPixels = scaledWidth * scaledHeight;
      
      let optimalThreads;
      if (totalPixels > 4000000) {
        optimalThreads = Math.min(4, require('os').cpus().length);
      } else if (totalPixels > 2000000) {
        optimalThreads = Math.min(2, require('os').cpus().length);
      } else {
        optimalThreads = 1;
      }
      
      let command = require('fluent-ffmpeg')(inputFile)
        .videoCodec(this.getVideoCodec(s.codec))
        .audioCodec(this.getAudioCodec())
        .addOption('-threads', optimalThreads.toString())
        .addOption('-movflags', 'faststart')
        .addOption('-pix_fmt', 'yuv420p');
      
      if (isLargeVideo) {
        command = command
          .addOption('-bufsize', '2M')
          .addOption('-maxrate', '10M');
      }
      
      if (this.isFFmpegLimited || s.bitrate) {
        command = command.videoBitrate(s.bitrate || '1200k');
      } else {
        command = command.addOption('-crf', s.crf.toString());
        if (!s.codec.includes('nvenc')) {
          command = command.addOption('-preset', s.preset);
        }
      }
      
      if (s.scale < 1.0) {
        const w = Math.round(width * s.scale);
        const h = Math.round(height * s.scale);
        command = command.size(`${w}x${h}`);
      }
      
      command = command.output(tempOut);
      
      try {
        await this.executeCompression(command);
        const stats = await fs.stat(tempOut);
        const result = { ...s, tempPath: tempOut, size: stats.size };
        
        if (!this.options.skip) {
          console.log(`Result: ${(stats.size / (1024*1024)).toFixed(2)}MB (target: ${(targetSize / (1024*1024)).toFixed(2)}MB)`);
        }
        
        if (stats.size <= targetSize) {
          bestResult = result;
          for (let j = 0; j < i; j++) {
            try { 
              const oldTemp = outputPath.replace(/\.[^.]+$/, `_extreme_${j}.mp4`);
              await fs.unlink(oldTemp); 
            } catch {}
          }
          break;
        } else {
          try { await fs.unlink(tempOut); } catch {}
          if (!bestResult || stats.size < bestResult.size) {
            bestResult = result;
            bestResult.tempPath = null;
          }
        }
      } catch (e) {
        if (!this.options.skip) {
          console.log(`Failed: ${e.message.split('\n')[0]}`);
        }
        try { await fs.unlink(tempOut); } catch {}
        continue;
      }
    }
    
    if (!bestResult) {
      throw new Error('No compression strategy succeeded');
    }
    
    const finalExt = this.getExtensionForFormat('mp4'); // Always use MP4 for SteelSeries compatibility
    const finalOutputPath = outputPath.replace(/\.[^.]+$/, finalExt);
    
    if (bestResult.tempPath && require('fs').existsSync(bestResult.tempPath)) {
      await fs.rename(bestResult.tempPath, finalOutputPath);
    } else {
      if (!this.options.skip) {
        console.log('Recreating best strategy for final output...');
      }
      
      const scaledWidth = Math.round(width * bestResult.scale);
      const scaledHeight = Math.round(height * bestResult.scale);
      const totalPixels = scaledWidth * scaledHeight;
      
      let optimalThreads;
      if (totalPixels > 4000000) {
        optimalThreads = Math.min(4, require('os').cpus().length);
      } else if (totalPixels > 2000000) {
        optimalThreads = Math.min(2, require('os').cpus().length);
      } else {
        optimalThreads = 1;
      }
      
      let command = require('fluent-ffmpeg')(inputFile)
        .videoCodec(this.getVideoCodec(bestResult.codec))
        .audioCodec(this.getAudioCodec())
        .addOption('-threads', optimalThreads.toString())
        .addOption('-movflags', 'faststart')
        .addOption('-pix_fmt', 'yuv420p');
      
      if (isLargeVideo) {
        command = command
          .addOption('-bufsize', '2M')
          .addOption('-maxrate', '10M');
      }
      
      if (this.isFFmpegLimited || bestResult.bitrate) {
        command = command.videoBitrate(bestResult.bitrate || '1200k');
      } else {
        command = command.addOption('-crf', bestResult.crf.toString());
        if (!bestResult.codec.includes('nvenc')) {
          command = command.addOption('-preset', bestResult.preset);
        }
      }
      
      if (bestResult.scale < 1.0) {
        const w = Math.round(width * bestResult.scale);
        const h = Math.round(height * bestResult.scale);
        command = command.size(`${w}x${h}`);
      }
      command = command.output(finalOutputPath);
      await this.executeCompression(command);
    }
    
    if (!this.options.skip) {
      const targetMB = (targetSize / (1024*1024)).toFixed(2);
      const resultMB = ((bestResult.size || 0) / (1024*1024)).toFixed(2);
      if (bestResult.size <= targetSize) {
        console.log(`Extreme: Target achieved! ${resultMB}MB (${bestResult.codec}${bestResult.crf ? `, crf=${bestResult.crf}` : `, bitrate=${bestResult.bitrate}`}, scale=${bestResult.scale})`);
      } else {
        console.log(`Extreme: Best effort ${resultMB}MB of ${targetMB}MB target (${bestResult.codec}${bestResult.crf ? `, crf=${bestResult.crf}` : `, bitrate=${bestResult.bitrate}`}, scale=${bestResult.scale})`);
      }
    }
    
    return finalOutputPath;
  }

  async parallelExtremeCompressionStrategy(inputFile, outputPath, metadata, options, originalSize, targetSize) {
    if (!this.options.skip) {
      console.log('Extreme video compression mode: parallel strategies (controlled batches)...');
    }
    
    const duration = metadata.format?.duration || 60;
    const width = metadata.streams?.[0]?.width || 1920;
    const height = metadata.streams?.[0]?.height || 1080;
    const isLargeVideo = width > 2560 || height > 1440;
    
    let strategies = [];
    
    if (this.isFFmpegLimited) {
      const resolutions = isLargeVideo ? [0.5, 0.3, 0.2] : [1.0, 0.7, 0.5];
      const bitrates = isLargeVideo ? ['400k', '200k', '100k'] : ['800k', '600k', '400k', '200k'];
      const codecs = ['h264_nvenc'];
      
      for (const codec of codecs) {
        for (const bitrate of bitrates) {
          for (const scale of resolutions) {
            strategies.push({ codec, bitrate, scale, preset: 'fast' });
          }
        }
      }
    } else {
      const resolutions = isLargeVideo ? [0.5, 0.3, 0.2] : [1.0, 0.7, 0.5];
      const crfs = isLargeVideo ? [32, 36, 40, 45] : [28, 32, 36, 40];
      const presets = ['fast', 'medium'];
      const codecs = ['h264'];
      
      for (const codec of codecs) {
        for (const preset of presets) {
          for (const crf of crfs) {
            for (const scale of resolutions) {
              strategies.push({ codec, preset, crf, scale });
            }
          }
        }
      }
    }
    
    const maxConcurrent = isLargeVideo ? Math.min(2, require('os').cpus().length) : Math.min(3, require('os').cpus().length); 
    const batchSize = Math.ceil(strategies.length / maxConcurrent);
    
    if (!this.options.skip) {
      console.log(`Testing ${strategies.length} strategies in ${Math.ceil(strategies.length / batchSize)} batches of max ${batchSize} strategies`);
      if (isLargeVideo) {
        console.log(`Large video detected (${width}x${height}) - using conservative settings`);
      }
    }
    
    let bestResult = null;
    let batchIndex = 0;
    
    for (let i = 0; i < strategies.length; i += batchSize) {
      batchIndex++;
      const batch = strategies.slice(i, Math.min(i + batchSize, strategies.length));
      
      if (!this.options.skip) {
        console.log(`Testing batch ${batchIndex}/${Math.ceil(strategies.length / batchSize)} (${batch.length} strategies)...`);
      }
      
      const batchPromises = batch.map(async (strategy, strategyIndex) => {
        const globalIndex = i + strategyIndex;
        const tempOut = outputPath.replace(/\.[^.]+$/, `_extreme_${globalIndex}.mp4`);
        
        try {
          const scaledWidth = Math.round(width * strategy.scale);
          const scaledHeight = Math.round(height * strategy.scale);
          const totalPixels = scaledWidth * scaledHeight;
          
          let optimalThreads;
          if (totalPixels > 4000000) {
            optimalThreads = Math.min(4, require('os').cpus().length);
          } else if (totalPixels > 2000000) {
            optimalThreads = Math.min(2, require('os').cpus().length);
          } else {
            optimalThreads = 1;
          }
          
          let command = require('fluent-ffmpeg')(inputFile)
            .videoCodec(this.getVideoCodec(strategy.codec))
            .audioCodec(this.getAudioCodec())
            .addOption('-threads', optimalThreads.toString())
            .addOption('-movflags', 'faststart')
            .addOption('-pix_fmt', 'yuv420p');
          
          if (isLargeVideo) {
            command = command
              .addOption('-bufsize', '2M')
              .addOption('-maxrate', '10M');
          }
          
          if (this.isFFmpegLimited || strategy.bitrate) {
            command = command.videoBitrate(strategy.bitrate || '1200k');
          } else {
            command = command.addOption('-crf', strategy.crf.toString());
            if (!strategy.codec.includes('nvenc')) {
              command = command.addOption('-preset', strategy.preset);
            }
          }
          
          if (strategy.scale < 1.0) {
            const w = Math.round(width * strategy.scale);
            const h = Math.round(height * strategy.scale);
            command = command.size(`${w}x${h}`);
          }
          
          command = command.output(tempOut);
          await this.executeCompression(command);
          
          const stats = await fs.stat(tempOut);
          const result = { ...strategy, tempPath: tempOut, size: stats.size, index: globalIndex };
          
          if (!this.options.skip) {
            console.log(`Strategy ${globalIndex+1}: ${(stats.size / (1024*1024)).toFixed(2)}MB (target: ${(targetSize / (1024*1024)).toFixed(2)}MB)`);
          }
          
          return result;
        } catch (e) {
          if (!this.options.skip) {
            console.log(`Strategy ${globalIndex+1} failed: ${e.message.split('\n')[0]}`);
          }
          try { await fs.unlink(tempOut); } catch {}
          return null;
        }
      });
      
      const batchResults = await Promise.all(batchPromises);
      
      for (const result of batchResults) {
        if (!result) continue;
        
        if (result.size <= targetSize) {
          bestResult = result;
          
          if (!this.options.skip) {
            console.log(`Target achieved! Cleaning up temporary files...`);
          }
          
          for (let j = 0; j < strategies.length; j++) {
            if (j !== result.index) {
              try {
                const tempFile = outputPath.replace(/\.[^.]+$/, `_extreme_${j}.mp4`);
                await fs.unlink(tempFile);
              } catch {}
            }
          }
          
          break;
        } else {
          try { await fs.unlink(result.tempPath); } catch {}
          if (!bestResult || result.size < bestResult.size) {
            bestResult = result;
            bestResult.tempPath = null;
          }
        }
      }
      
      if (bestResult && bestResult.tempPath) {
        break;
      }
      
      await new Promise(resolve => setTimeout(resolve, isLargeVideo ? 1000 : 500));
    }
    
    if (!bestResult) {
      throw new Error('No compression strategy succeeded');
    }
    
    const finalExt = this.getExtensionForFormat('mp4');
    const finalOutputPath = outputPath.replace(/\.[^.]+$/, finalExt);
    
    if (bestResult.tempPath && require('fs').existsSync(bestResult.tempPath)) {
      await fs.rename(bestResult.tempPath, finalOutputPath);
    } else {
      if (!this.options.skip) {
        console.log('Recreating best strategy for final output...');
      }
      
      const scaledWidth = Math.round(width * bestResult.scale);
      const scaledHeight = Math.round(height * bestResult.scale);
      const totalPixels = scaledWidth * scaledHeight;
      
      let optimalThreads;
      if (totalPixels > 4000000) {
        optimalThreads = Math.min(4, require('os').cpus().length);
      } else if (totalPixels > 2000000) {
        optimalThreads = Math.min(2, require('os').cpus().length);
      } else {
        optimalThreads = 1;
      }
      
      let command = require('fluent-ffmpeg')(inputFile)
        .videoCodec(this.getVideoCodec(bestResult.codec))
        .audioCodec(this.getAudioCodec())
        .addOption('-threads', optimalThreads.toString())
        .addOption('-movflags', 'faststart')
        .addOption('-pix_fmt', 'yuv420p');
      
      if (isLargeVideo) {
        command = command
          .addOption('-bufsize', '2M')
          .addOption('-maxrate', '10M');
      }
      
      if (this.isFFmpegLimited || bestResult.bitrate) {
        command = command.videoBitrate(bestResult.bitrate || '1200k');
      } else {
        command = command.addOption('-crf', bestResult.crf.toString());
        if (!bestResult.codec.includes('nvenc')) {
          command = command.addOption('-preset', bestResult.preset);
        }
      }
      
      if (bestResult.scale < 1.0) {
        const w = Math.round(width * bestResult.scale);
        const h = Math.round(height * bestResult.scale);
        command = command.size(`${w}x${h}`);
      }
      command = command.output(finalOutputPath);
      await this.executeCompression(command);
    }
    
    if (!this.options.skip) {
      const targetMB = (targetSize / (1024*1024)).toFixed(2);
      const resultMB = ((bestResult.size || 0) / (1024*1024)).toFixed(2);
      if (bestResult.size <= targetSize) {
        console.log(`Parallel Extreme: Target achieved! ${resultMB}MB (${bestResult.codec}${bestResult.crf ? `, crf=${bestResult.crf}` : `, bitrate=${bestResult.bitrate}`}, scale=${bestResult.scale})`);
      } else {
        console.log(`Parallel Extreme: Best effort ${resultMB}MB of ${targetMB}MB target (${bestResult.codec}${bestResult.crf ? `, crf=${bestResult.crf}` : `, bitrate=${bestResult.bitrate}`}, scale=${bestResult.scale})`);
      }
    }
    
    return finalOutputPath;
  }

  async standardCompressionStrategy(inputFile, outputPath, metadata, options, originalSize, targetSize) {
    const duration = metadata.format?.duration || 60;
    const audioBitrate = 96;
    const overheadFactor = 0.85;
    const targetBitrate = Math.floor(((targetSize * 8 * overheadFactor) / duration - audioBitrate * 1024) / 1024);
    const finalBitrate = Math.max(100, Math.min(targetBitrate, 10000));
    let command = require('fluent-ffmpeg')(inputFile)
      .videoCodec(this.isFFmpegLimited ? 'h264_nvenc' : 'libx264')
      .audioCodec(this.getAudioCodec())
      .videoBitrate(`${finalBitrate}k`)
      .audioBitrate('96k')
      .addOption('-movflags', 'faststart')
      .addOption('-threads', '0');
    
    if (!this.isFFmpegLimited) {
      command = command.addOption('-preset', this.speedOptimized ? 'ultrafast' : 'medium');
    }
    
    command = command.output(outputPath);
    if (outputPath !== inputFile) {
      try { await fs.unlink(outputPath); } catch {}
    }
    await this.executeCompression(command);
    return outputPath;
  }

  async executeCompression(command) {
    return new Promise((resolve, reject) => {
      let lastPercent = 0;
      command
        .on('progress', (progress) => {
          if (progress.percent && progress.percent - lastPercent >= 5) {
            lastPercent = progress.percent;
            process.stdout.write(`\r  Progress: ${Math.round(progress.percent)}% ${progress.timemark || ''}`);
          }
        })
        .on('end', () => {
          process.stdout.write('\r  Progress: 100%\n');
          resolve();
        })
        .on('error', (err, stdout, stderr) => {
          console.error('FFmpeg error:', err.message);
          if (stdout) console.error('FFmpeg stdout:', stdout);
          if (stderr) console.error('FFmpeg stderr:', stderr);
          reject(err);
        })
        .run();
    });
  }

  getOutputFormat(outputPath) {
    const ext = path.extname(outputPath).toLowerCase();
    switch (ext) {
      case '.mp4': return 'mp4';
      case '.webm': return 'webm';
      case '.avi': return 'avi';
      case '.mov': return 'mov';
      case '.mkv': return 'mkv';
      default: return 'mp4';
    }
  }

  getExtensionForFormat(format) {
    switch (format) {
      case 'mp4': return '.mp4';
      case 'webm': return '.webm';
      case 'avi': return '.avi';
      case 'mov': return '.mov';
      case 'mkv': return '.mkv';
      default: return '.mp4';
    }
  }

  generateOutputPath(inputFile, options) {
    if (options.output) {
      if (options.output.endsWith('/') || options.output.endsWith('\\')) {
        const basename = path.basename(inputFile, path.extname(inputFile));
        const ext = this.getOutputExtension(inputFile, options.format);
        const suffix = '_compressed';
        return path.join(options.output, `${basename}${suffix}${ext}`);
      } else {
        return options.output;
      }
    } else {
      const dir = path.dirname(inputFile);
      const basename = path.basename(inputFile, path.extname(inputFile));
      const ext = this.getOutputExtension(inputFile, options.format);
      const suffix = '_compressed';
      return path.join(dir, `${basename}${suffix}${ext}`);
    }
  }

  getOutputExtension(inputFile, formatOption) {
    if (formatOption && formatOption !== 'auto') {
      switch (formatOption.toLowerCase()) {
        case 'mp4':
          return '.mp4';
        case 'avi':
          return '.avi';
        case 'mov':
          return '.mov';
        case 'mkv':
          return '.mkv';
        case 'webm':
          return '.webm';
        default:
          return path.extname(inputFile);
      }
    }
    
    return path.extname(inputFile);
  }

  static detectFFmpegPaths() {
    if (VideoCompressor._cachedPaths) {
      return VideoCompressor._cachedPaths;
    }

    let ffmpegPath = null;
    let ffprobePath = null;
    let isLimited = false;
    let detectionSource = '';

    const validateFFmpegPath = (ffmpegPath, ffprobePath) => {
      try {
        const ffmpegTest = spawnSync(ffmpegPath, ['-version'], { 
          stdio: 'pipe', 
          timeout: 5000,
          encoding: 'utf8'
        });

        if (ffmpegTest.status === 0) {
          const ffmpegVersion = ffmpegTest.stdout?.match(/ffmpeg version (\S+)/)?.[1] || '';
          const isLimited = ffmpegPath.toLowerCase().includes('steelseries') || 
                           ffmpegVersion.includes('minimal') || 
                           ffmpegVersion.includes('essentials') ||
                           ffmpegVersion.includes('gg-');

          let hasFFprobe = false;
          let actualFFprobePath = ffprobePath;
          try {
            const fsSync = require('fs');
            if (fsSync.existsSync(ffprobePath)) {
              const ffprobeTest = spawnSync(ffprobePath, ['-version'], { 
                stdio: 'pipe', 
                timeout: 5000,
                encoding: 'utf8'
              });
              hasFFprobe = ffprobeTest.status === 0;
            }
          } catch (e) {
          }

          if (isLimited && !hasFFprobe) {
            return { 
              valid: true, 
              version: ffmpegVersion, 
              isLimited: true, 
              hasFFprobe: false,
              ffprobePath: null 
            };
          }

          if (hasFFprobe) {
            return { 
              valid: true, 
              version: ffmpegVersion, 
              isLimited, 
              hasFFprobe: true,
              ffprobePath: actualFFprobePath 
            };
          }
        }
      } catch (e) {
      }
      return { valid: false };
    };

    const checkSystemPath = () => {
      const exeSuffix = process.platform === 'win32' ? '.exe' : '';
      const result = validateFFmpegPath(`ffmpeg${exeSuffix}`, `ffprobe${exeSuffix}`);
      if (result.valid) {
        return {
          ffmpegPath: `ffmpeg${exeSuffix}`,
          ffprobePath: result.ffprobePath || `ffprobe${exeSuffix}`,
          isLimited: result.isLimited,
          hasFFprobe: result.hasFFprobe,
          source: 'PATH'
        };
      }
      return null;
    };

    const checkCommonDirectories = () => {
      const fsSync = require('fs');
      const exeSuffix = process.platform === 'win32' ? '.exe' : '';
      
      let commonDirs = [];
      
      if (process.platform === 'win32') {
        commonDirs = [
          path.join(process.env.USERPROFILE || '', 'scoop', 'apps', 'ffmpeg', 'current', 'bin'),
          path.join(process.env.USERPROFILE || '', 'Desktop', 'ffmpeg*', 'bin'),
          path.join(process.env.USERPROFILE || '', 'Downloads', 'ffmpeg*', 'bin'),
          'C:\\ffmpeg\\bin',
          'C:\\Program Files\\ffmpeg\\bin',
          'C:\\Program Files (x86)\\ffmpeg\\bin',
          'C:\\ProgramData\\chocolatey\\lib\\ffmpeg\\tools\\ffmpeg\\bin',
          path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages', '*ffmpeg*', 'bin'),
          'C:\\Program Files\\SteelSeries\\GG\\apps\\moments',
          'C:\\Program Files (x86)\\SteelSeries\\GG\\apps\\moments'
        ];
      } else if (process.platform === 'darwin') {
        commonDirs = [
          '/opt/homebrew/bin',
          '/usr/local/bin',
          '/usr/bin',
          '/opt/local/bin',
          '/Applications/ffmpeg/bin'
        ];
      } else {
        commonDirs = [
          '/usr/local/bin',
          '/usr/bin',
          '/snap/bin',
          '/opt/ffmpeg/bin',
          path.join(process.env.HOME || '', '.local', 'bin')
        ];
      }

      const expandedDirs = [];
      for (const dir of commonDirs) {
        if (dir.includes('*')) {
          try {
            const parentDir = path.dirname(dir);
            const pattern = path.basename(dir);
            const entries = fsSync.readdirSync(parentDir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory() && entry.name.match(pattern.replace('*', '.*'))) {
                expandedDirs.push(path.join(parentDir, entry.name));
              }
            }
          } catch (e) {
          }
        } else {
          expandedDirs.push(dir);
        }
      }

      for (const dir of expandedDirs) {
        const ffmpegPath = path.join(dir, `ffmpeg${exeSuffix}`);
        const ffprobePath = path.join(dir, `ffprobe${exeSuffix}`);
        
        try {
          if (fsSync.existsSync(ffmpegPath) && fsSync.existsSync(ffprobePath)) {
            const result = validateFFmpegPath(ffmpegPath, ffprobePath);
            if (result.valid) {
              return {
                ffmpegPath,
                ffprobePath: result.ffprobePath || ffprobePath,
                isLimited: result.isLimited,
                hasFFprobe: result.hasFFprobe,
                source: `common_dir:${dir}`
              };
            }
          }
        } catch (e) {
        }
      }
      return null;
    };

    const checkWindowsRegistry = () => {
      if (process.platform !== 'win32') return null;
      
      try {
        const regPaths = [
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\FFmpeg',
          'HKEY_CURRENT_USER\\SOFTWARE\\FFmpeg',
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\FFmpeg'
        ];

        for (const regPath of regPaths) {
          try {
            const result = spawnSync('reg', ['query', regPath, '/v', 'InstallDir'], { 
              encoding: 'utf8', 
              stdio: 'pipe' 
            });
            if (result.status === 0) {
              const match = result.stdout.match(/InstallDir\s+REG_SZ\s+(.+)/);
              if (match) {
                const installDir = match[1].trim();
                const binDir = path.join(installDir, 'bin');
                const ffmpegPath = path.join(binDir, 'ffmpeg.exe');
                const ffprobePath = path.join(binDir, 'ffprobe.exe');
                
                const validation = validateFFmpegPath(ffmpegPath, ffprobePath);
                if (validation.valid) {
                  return {
                    ffmpegPath,
                    ffprobePath: validation.ffprobePath || ffprobePath,
                    isLimited: validation.isLimited,
                    hasFFprobe: validation.hasFFprobe,
                    source: 'registry'
                  };
                }
              }
            }
          } catch (e) {
          }
        }
      } catch (e) {
      }
      return null;
    };

    const intelligentSearch = () => {
      if (process.platform !== 'win32') return null;
      
      try {
        const searchRoots = [
          'C:\\Program Files',
          'C:\\Program Files (x86)',
          process.env.USERPROFILE
        ];

        for (const root of searchRoots) {
          try {
            const result = spawnSync('where', ['/R', root, 'ffmpeg.exe'], { 
              encoding: 'utf8', 
              timeout: 10000,
              stdio: 'pipe'
            });
            
            if (result.status === 0 && result.stdout) {
              const ffmpegPaths = result.stdout.split(/\r?\n/).filter(Boolean);
              for (const ffmpegPath of ffmpegPaths) {
                const ffprobePath = path.join(path.dirname(ffmpegPath), 'ffprobe.exe');
                const validation = validateFFmpegPath(ffmpegPath, ffprobePath);
                if (validation.valid) {
                  return {
                    ffmpegPath,
                    ffprobePath: validation.ffprobePath,
                    isLimited: validation.isLimited,
                    hasFFprobe: validation.hasFFprobe,
                    source: 'system_search'
                  };
                }
              }
            }
          } catch (e) {
          }
        }
      } catch (e) {
      }
      return null;
    };

    const strategies = [
      { name: 'PATH', func: checkSystemPath },
      { name: 'CommonDirs', func: checkCommonDirectories },
      { name: 'Registry', func: checkWindowsRegistry },
      { name: 'SystemSearch', func: intelligentSearch }
    ];

    for (const strategy of strategies) {
      const result = strategy.func();
      if (result) {
        ffmpegPath = result.ffmpegPath;
        ffprobePath = result.ffprobePath;
        isLimited = result.isLimited;
        detectionSource = result.source;
        break;
      }
    }

    const hasFFprobe = ffprobePath !== null;
    const finalResult = { ffmpegPath, ffprobePath, isLimited, hasFFprobe, detectionSource };
    VideoCompressor._cachedPaths = finalResult;
    setTimeout(() => {
      delete VideoCompressor._cachedPaths;
    }, 5 * 60 * 1000);

    return finalResult;
  }

  static clearDetectionCache() {
    delete VideoCompressor._cachedPaths;
  }

  parseTargetSize(targetSize) {
    const units = {
      'B': 1,
      'KB': 1024,
      'MB': 1024 * 1024,
      'GB': 1024 * 1024 * 1024
    };
    
    const match = targetSize.toString().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i);
    
    if (!match) {
      throw new Error(`Invalid target size format: ${targetSize}`);
    }
    
    const value = parseFloat(match[1]);
    const unit = (match[2] || 'B').toUpperCase();
    
    return Math.floor(value * units[unit]);
  }
}

module.exports = { VideoCompressor };