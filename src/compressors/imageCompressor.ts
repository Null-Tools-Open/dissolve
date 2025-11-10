const sharp = require('sharp');
const path = require('path');
const fs = require('fs').promises;

type CompressionOptions = Record<string, any>;
type CompressionResult = Record<string, any>;

class ImageCompressor {
  [key: string]: any;
  private options: CompressionOptions;
  private speedOptimized: boolean;
  private skipOptimizations: boolean;

  constructor(options: CompressionOptions = {}) {
    this.options = options;
    this.speedOptimized = options.speedOptimized || false;
    this.skipOptimizations = options.skipOptimizations || false;
  }

  async compress(inputFile: string | Buffer, options: CompressionOptions = {}): Promise<CompressionResult> {
    const mergedOptions = { ...this.options, ...options };
    let originalSize: number;
    let outputPath: string | undefined;
    let sharpInstance: any;
    let metadata: any;

    if (Buffer.isBuffer(inputFile)) {
      originalSize = inputFile.length;
      sharpInstance = sharp(inputFile, { 
        failOnError: false,
        limitInputPixels: 268402689
      });
      metadata = await sharpInstance.metadata();
      sharpInstance = await this.applyTransformations(sharpInstance, metadata, mergedOptions);
      
      const format = this.determineOutputFormat('fragment.jpg', mergedOptions.format);
      const buffer = await this.compressToBuffer(sharpInstance, format, mergedOptions, originalSize);
      
      return {
        inputFile,
        outputFile: null,
        originalSize,
        compressedSize: buffer.length,
        buffer,
        reduction: ((originalSize - buffer.length) / originalSize * 100).toFixed(2),
        metadata: {
          width: metadata.width,
          height: metadata.height,
          format: metadata.format,
          hasAlpha: metadata.hasAlpha
        }
      };
    } else {
      const originalStats = await fs.stat(inputFile);
      originalSize = originalStats.size;
      outputPath = this.generateOutputPath(inputFile, mergedOptions);
      
      sharpInstance = sharp(inputFile, { 
        failOnError: false,
        limitInputPixels: 268402689
      });
      metadata = await sharpInstance.metadata();
      sharpInstance = await this.applyTransformations(sharpInstance, metadata, mergedOptions);
      
      const finalOutputPath = await this.compressToFile(
        sharpInstance, 
        outputPath, 
        mergedOptions, 
        originalSize, 
        metadata
      );
      
      const compressedStats = await fs.stat(finalOutputPath);
      const compressedSize = compressedStats.size;
      
      return {
        inputFile,
        outputFile: finalOutputPath,
        originalSize,
        compressedSize,
        reduction: ((originalSize - compressedSize) / originalSize * 100).toFixed(2),
        metadata: {
          width: metadata.width,
          height: metadata.height,
          format: metadata.format,
          hasAlpha: metadata.hasAlpha
        }
      };
    }
  }

  async applyTransformations(sharpInstance, metadata, options) {
    sharpInstance = sharpInstance.toColorspace('srgb');
    
    sharpInstance = sharpInstance.withMetadata({
      orientation: metadata.orientation
    });

    if (options.width || options.height) {
      const resizeOptions = {
        width: options.width ? parseInt(options.width) : null,
        height: options.height ? parseInt(options.height) : null,
        fit: 'inside',
        withoutEnlargement: true,
        kernel: this.speedOptimized ? 'nearest' : 'lanczos3'
      };
      sharpInstance = sharpInstance.resize(resizeOptions);
    }
    
    if (options.targetSize) {
      const targetBytes = this.parseTargetSize(options.targetSize);
      sharpInstance._targetSize = targetBytes;
      sharpInstance._originalSize = metadata.size;
    }
    
    return sharpInstance;
  }

  async compressToBuffer(sharpInstance, format, options, originalSize) {
    const targetSize = sharpInstance._targetSize;
    
    if (targetSize) {
      return await this.compressToTargetSizeBuffer(
        sharpInstance, 
        format, 
        options, 
        originalSize, 
        targetSize
      );
    }

    const quality = parseInt(options.quality) || 85;
    
    switch (format.toLowerCase()) {
      case 'avif':
        return await sharpInstance.avif({ 
          quality: Math.max(20, quality - 35),
          effort: this.speedOptimized ? 2 : 6,
          chromaSubsampling: '4:2:0'
        }).toBuffer();
        
      case 'webp':
        return await sharpInstance.webp({ 
          quality,
          effort: this.speedOptimized ? 2 : 6,
          smartSubsample: true
        }).toBuffer();
        
      case 'jpeg':
      case 'jpg':
        return await sharpInstance.jpeg({ 
          quality,
          progressive: true,
          mozjpeg: !this.speedOptimized,
          chromaSubsampling: '4:2:0'
        }).toBuffer();
        
      case 'png':
        return await sharpInstance.png({ 
          quality,
          compressionLevel: this.speedOptimized ? 6 : 9,
          palette: quality < 90,
          effort: this.speedOptimized ? 5 : 10
        }).toBuffer();
        
      default:
        return await sharpInstance.jpeg({ quality, progressive: true }).toBuffer();
    }
  }

  async compressToFile(sharpInstance, outputPath, options, originalSize, metadata) {
    const format = this.determineOutputFormat(outputPath, options.format);
    const targetSize = sharpInstance._targetSize;
    
    if (targetSize) {
      return await this.compressToTargetSizeFile(
        sharpInstance, 
        outputPath, 
        format, 
        options, 
        originalSize, 
        targetSize
      );
    }

    const quality = parseInt(options.quality) || 85;
    let finalPath = outputPath;
    
    if (options.format === 'auto' || !options.format) {
      const result = await this.findBestFormat(sharpInstance, metadata, quality, originalSize);
      finalPath = outputPath.replace(/\.[^.]+$/, result.extension);
      await fs.writeFile(finalPath, result.buffer);
      return finalPath;
    }
    
    const compressionOptions = this.getCompressionOptions(format, quality);
    await sharpInstance[format](compressionOptions).toFile(finalPath);
    return finalPath;
  }

  async findBestFormat(sharpInstance, metadata, quality, originalSize) {
    const hasAlpha = metadata.hasAlpha;
    const formats = [];
    
    formats.push({
      format: 'avif',
      extension: '.avif',
      promise: sharpInstance.clone().avif({ 
        quality: Math.max(20, quality - 35),
        effort: 4,
        chromaSubsampling: '4:2:0'
      }).toBuffer()
    });
    
    formats.push({
      format: 'webp',
      extension: '.webp',
      promise: sharpInstance.clone().webp({ 
        quality,
        effort: 4,
        smartSubsample: true
      }).toBuffer()
    });
    
    if (!hasAlpha) {
      formats.push({
        format: 'jpeg',
        extension: '.jpg',
        promise: sharpInstance.clone().jpeg({ 
          quality,
          progressive: true,
          mozjpeg: true,
          chromaSubsampling: '4:2:0'
        }).toBuffer()
      });
    }
    
    if (hasAlpha || quality > 90) {
      formats.push({
        format: 'png',
        extension: '.png',
        promise: sharpInstance.clone().png({ 
          quality,
          compressionLevel: 9,
          palette: quality < 90,
          effort: 10
        }).toBuffer()
      });
    }

    const results = await Promise.all(
      formats.map(async (f) => {
        try {
          const buffer = await f.promise;
          return { ...f, buffer, size: buffer.length };
        } catch (error) {
          return { ...f, error, size: Infinity };
        }
      })
    );

    const best = results
      .filter(r => !r.error && r.size < originalSize * 0.95)
      .sort((a, b) => a.size - b.size)[0] || results[0];

    if (!this.options.skip) {
      console.log(`Auto-format selection: ${best.format.toUpperCase()} (${(best.size / 1024).toFixed(1)}KB)`);
      results.forEach(r => {
        if (!r.error) {
          console.log(`   ${r.format === best.format ? '✓' : '  '} ${r.format}: ${(r.size / 1024).toFixed(1)}KB`);
        }
      });
    }

    return best;
  }

  getCompressionOptions(format, quality) {
    switch (format.toLowerCase()) {
      case 'avif':
        return {
          quality: Math.max(20, quality - 35),
          effort: this.speedOptimized ? 2 : 6,
          chromaSubsampling: '4:2:0',
          lossless: false
        };
        
      case 'webp':
        return {
          quality,
          effort: this.speedOptimized ? 2 : 6,
          lossless: false,
          smartSubsample: true,
          nearLossless: false
        };
        
      case 'jpeg':
      case 'jpg':
        return {
          quality,
          progressive: true,
          mozjpeg: !this.speedOptimized,
          chromaSubsampling: '4:2:0',
          optimiseCoding: !this.skipOptimizations,
          optimiseScans: !this.skipOptimizations
        };
        
      case 'png':
        return {
          quality,
          compressionLevel: this.speedOptimized ? 6 : 9,
          palette: quality < 90,
          adaptiveFiltering: !this.skipOptimizations,
          effort: this.speedOptimized ? 5 : 10
        };
        
      default:
        return { quality };
    }
  }

  async compressToTargetSizeFile(sharpInstance, outputPath, format, options, originalSize, targetSize) {
    const compressionRatio = targetSize / originalSize;
    
    if (!this.options.skip) {
      console.log(`Target: ${(targetSize / 1024).toFixed(1)}KB (${(compressionRatio * 100).toFixed(1)}% compression)`);
    }
    
    if (compressionRatio < 0.10) {
      return await this.extremeCompressionParallel(
        sharpInstance, 
        outputPath, 
        format, 
        options, 
        originalSize, 
        targetSize
      );
    }
    
    return await this.standardCompression(
      sharpInstance, 
      outputPath, 
      format, 
      options, 
      targetSize
    );
  }

  async compressToTargetSizeBuffer(sharpInstance, format, options, originalSize, targetSize) {
    const compressionRatio = targetSize / originalSize;
    
    if (compressionRatio < 0.10) {
      const result = await this.extremeCompressionParallel(
        sharpInstance, 
        'temp.jpg', 
        format, 
        options, 
        originalSize, 
        targetSize
      );
      return await fs.readFile(result);
    }
    
    return await this.standardCompressionBuffer(
      sharpInstance, 
      format, 
      options, 
      targetSize
    );
  }

  async extremeCompressionParallel(sharpInstance, outputPath, format, options, originalSize, targetSize) {
    const metadata = await sharpInstance.metadata();
    const keepDims = options.keepDimensions;
    
    const strategies = this.generateCompressionStrategies(keepDims, format);
    
    if (!this.options.skip) {
      console.log(`Extreme mode: ${strategies.length} parallel strategies...`);
    }

    const results = await Promise.allSettled(
      strategies.map(strategy => this.testStrategy(sharpInstance, strategy, metadata, keepDims))
    );

    const successful = results
      .filter(r => r.status === 'fulfilled' && r.value.success && r.value.size <= targetSize)
      .map(r => (r as PromiseFulfilledResult<any>).value)
      .sort((a, b) => a.size - b.size);

    if (successful.length > 0) {
      const chosen = this.selectBestResult(successful, options.strategy || 'auto', targetSize);
      
      const ext = this.getExtensionForFormat(chosen.strategy.format);
      const finalPath = outputPath.replace(/\.[^.]+$/, ext);
      
      await fs.writeFile(finalPath, chosen.buffer);
      
      if (!this.options.skip) {
        this.logCompressionResult(chosen, originalSize, finalPath);
      }
      
      return finalPath;
    }

    if (!this.options.skip) {
      console.log(`No strategy reached the target. Fallback...`);
    }
    
    return await this.standardCompression(sharpInstance, outputPath, format, options, targetSize);
  }

  generateCompressionStrategies(keepDims, preferredFormat) {
    const strategies = [];
    const formats = preferredFormat && preferredFormat !== 'auto' 
      ? [preferredFormat] 
      : ['avif', 'webp', 'jpeg', 'png'];
    
    for (const fmt of formats) {
      if (fmt === 'avif') {
        strategies.push(
          { format: 'avif', quality: 20, effort: 8 },
          { format: 'avif', quality: 25, effort: 6 },
          { format: 'avif', quality: 30, effort: 4 },
          { format: 'avif', quality: 35, effort: 2 }
        );
      } else if (fmt === 'webp') {
        strategies.push(
          { format: 'webp', quality: 10, effort: 6 },
          { format: 'webp', quality: 20, effort: 4 },
          { format: 'webp', quality: 30, effort: 2 }
        );
      } else if (fmt === 'jpeg') {
        strategies.push(
          { format: 'jpeg', quality: 10 },
          { format: 'jpeg', quality: 20 },
          { format: 'jpeg', quality: 30 }
        );
      } else if (fmt === 'png') {
        strategies.push(
          { format: 'png', quality: 10, palette: true, colors: 64 },
          { format: 'png', quality: 20, palette: true, colors: 128 }
        );
      }
    }
    
    if (!keepDims) {
      const resizes = [0.8, 0.6, 0.5, 0.4, 0.3, 0.2, 0.15, 0.1];
      
      for (const resize of resizes) {
        strategies.push(
          { format: 'avif', quality: 30, effort: 2, resize },
          { format: 'webp', quality: 40, effort: 2, resize },
          { format: 'jpeg', quality: 50, resize }
        );
      }
    }
    
    return strategies;
  }

  async testStrategy(sharpInstance, strategy, metadata, keepDims) {
    try {
      let instance = sharpInstance.clone();
      const startTime = Date.now();
      
      if (strategy.resize && !keepDims) {
        const newWidth = Math.max(16, Math.floor(metadata.width * strategy.resize));
        const newHeight = Math.max(16, Math.floor(metadata.height * strategy.resize));
        instance = instance.resize(newWidth, newHeight, { 
          fit: 'inside',
          kernel: 'lanczos3',
          withoutEnlargement: true
        });
      }
      
      let buffer;
      
      switch (strategy.format) {
        case 'avif':
          buffer = await instance.avif({
            quality: strategy.quality,
            effort: strategy.effort || 4,
            chromaSubsampling: '4:2:0',
            lossless: false
          }).toBuffer();
          break;
          
        case 'webp':
          buffer = await instance.webp({
            quality: strategy.quality,
            effort: strategy.effort || 4,
            smartSubsample: true,
            lossless: false
          }).toBuffer();
          break;
          
        case 'jpeg':
          buffer = await instance.jpeg({
            quality: strategy.quality,
            progressive: false,
            chromaSubsampling: '4:2:0',
            mozjpeg: false
          }).toBuffer();
          break;
          
        case 'png':
          buffer = await instance.png({
            quality: strategy.quality,
            compressionLevel: 9,
            palette: strategy.palette || false,
            colours: strategy.colors || 256,
            effort: 10
          }).toBuffer();
          break;
      }
      
      const processingTime = Date.now() - startTime;
      
      return {
        strategy,
        buffer,
        size: buffer.length,
        processingTime,
        success: true
      };
    } catch (error) {
      return {
        strategy,
        error: error.message,
        success: false,
        size: Infinity
      };
    }
  }

  selectBestResult(results, strategy, targetSize) {
    const smallest = results[0];
    const fastest = [...results].sort((a, b) => a.processingTime - b.processingTime)[0];
    const bestQuality = [...results].sort((a, b) => b.size - a.size)[0];
    
    switch (strategy) {
      case 'size':
        return smallest;
      case 'speed':
        return fastest;
      case 'quality':
        return bestQuality;
      case 'auto':
      default:
        const qualityUtil = (bestQuality.size / targetSize) * 100;
        if (qualityUtil <= 95) {
          return bestQuality;
        }
        return smallest;
    }
  }

  async standardCompression(sharpInstance, outputPath, format, options, targetSize) {
    const quality = options.quality || 85;
    
    if (['jpeg', 'jpg', 'webp', 'avif'].includes(format)) {
      return await this.binarySearchQuality(
        sharpInstance, 
        outputPath, 
        format, 
        targetSize,
        options
      );
    }
    
    if (format === 'png') {
      return await this.optimizePNG(sharpInstance, outputPath, targetSize, options);
    }
    
    await sharpInstance.toFile(outputPath);
    return outputPath;
  }

  async standardCompressionBuffer(sharpInstance, format, options, targetSize) {
    if (['jpeg', 'jpg', 'webp', 'avif'].includes(format)) {
      return await this.binarySearchQualityBuffer(
        sharpInstance, 
        format, 
        targetSize,
        options
      );
    }
    
    const quality = options.quality || 85;
    const compressionOptions = this.getCompressionOptions(format, quality);
    return await sharpInstance[format](compressionOptions).toBuffer();
  }

  async binarySearchQuality(sharpInstance, outputPath, format, targetSize, options) {
    let minQ = 5;
    let maxQ = 95;
    let bestBuffer = null;
    let attempts = 0;
    const maxAttempts = 15;
    
    while (minQ <= maxQ && attempts < maxAttempts) {
      const q = Math.floor((minQ + maxQ) / 2);
      const buffer = await this.compressWithQuality(sharpInstance.clone(), format, q, options);
      
      if (buffer.length <= targetSize) {
        bestBuffer = buffer;
        minQ = q + 1;
      } else {
        maxQ = q - 1;
      }
      attempts++;
    }
    
    if (bestBuffer) {
      await fs.writeFile(outputPath, bestBuffer);
      return outputPath;
    }
    
    const buffer = await this.compressWithQuality(sharpInstance, format, 5, options);
    await fs.writeFile(outputPath, buffer);
    return outputPath;
  }

  async binarySearchQualityBuffer(sharpInstance, format, targetSize, options) {
    let minQ = 5;
    let maxQ = 95;
    let bestBuffer = null;
    let attempts = 0;
    const maxAttempts = 15;
    
    while (minQ <= maxQ && attempts < maxAttempts) {
      const q = Math.floor((minQ + maxQ) / 2);
      const buffer = await this.compressWithQuality(sharpInstance.clone(), format, q, options);
      
      if (buffer.length <= targetSize) {
        bestBuffer = buffer;
        minQ = q + 1;
      } else {
        maxQ = q - 1;
      }
      attempts++;
    }
    
    return bestBuffer || await this.compressWithQuality(sharpInstance, format, 5, options);
  }

  async compressWithQuality(instance, format, quality, options) {
    const opts = this.getCompressionOptions(format, quality);
    return await instance[format](opts).toBuffer();
  }

  async optimizePNG(sharpInstance, outputPath, targetSize, options) {
    const configs = [
      { compressionLevel: 9, palette: true, quality: 50, colours: 128 },
      { compressionLevel: 9, palette: true, quality: 40, colours: 64 },
      { compressionLevel: 9, palette: true, quality: 30, colours: 32 },
      { compressionLevel: 9, palette: false, quality: 50 }
    ];
    
    for (const config of configs) {
      const buffer = await sharpInstance.clone().png(config).toBuffer();
      if (buffer.length <= targetSize) {
        await fs.writeFile(outputPath, buffer);
        return outputPath;
      }
    }
    
    const buffer = await sharpInstance.png(configs[0]).toBuffer();
    await fs.writeFile(outputPath, buffer);
    return outputPath;
  }

  logCompressionResult(result, originalSize, outputPath) {
    const reduction = ((originalSize - result.size) / originalSize * 100).toFixed(1);
    console.log(`✓ ${(originalSize / (1024*1024)).toFixed(1)}MB → ${(result.size / 1024).toFixed(1)}KB (${reduction}% less)`);
    console.log(`${this.getStrategyDescription(result.strategy)}`);
    console.log(`${result.processingTime}ms`);
    console.log(`${path.basename(outputPath)}`);
  }

  getStrategyDescription(strategy) {
    let desc = strategy.format.toUpperCase();
    if (strategy.quality) desc += ` Q${strategy.quality}`;
    if (strategy.resize) desc += ` ${(strategy.resize * 100).toFixed(0)}%`;
    if (strategy.effort) desc += ` E${strategy.effort}`;
    return desc;
  }

  getExtensionForFormat(format) {
    const map = {
      'avif': '.avif',
      'webp': '.webp',
      'jpeg': '.jpg',
      'png': '.png'
    };
    return map[format] || '.jpg';
  }

  determineOutputFormat(outputPath, formatOption) {
    if (formatOption && formatOption !== 'auto') {
      const formatMap = {
        'jpg': 'jpeg',
        'jpeg': 'jpeg',
        'png': 'png',
        'webp': 'webp',
        'avif': 'avif'
      };
      const normalized = formatMap[formatOption.toLowerCase()];
      if (normalized) {
        return normalized;
      }
      return formatOption.toLowerCase();
    }
    
    const ext = path.extname(outputPath).toLowerCase();
    const map = {
      '.avif': 'avif',
      '.webp': 'webp',
      '.jpg': 'jpeg',
      '.jpeg': 'jpeg',
      '.png': 'png'
    };
    
    return map[ext] || 'jpeg';
  }

  generateOutputPath(inputFile, options) {
    if (options.output) {
      if (options.output.endsWith('/') || options.output.endsWith('\\')) {
        const basename = path.basename(inputFile, path.extname(inputFile));
        const ext = this.getOutputExtension(inputFile, options.format);
        const suffix = options.overwrite ? '' : '_compressed';
        return path.join(options.output, `${basename}${suffix}${ext}`);
      }
      return options.output;
    }
    
    const dir = path.dirname(inputFile);
    const basename = path.basename(inputFile, path.extname(inputFile));
    const ext = this.getOutputExtension(inputFile, options.format);
    const suffix = options.overwrite ? '' : '_compressed';
    return path.join(dir, `${basename}${suffix}${ext}`);
  }

  getOutputExtension(inputFile, formatOption) {
    if (formatOption && formatOption !== 'auto') {
      return this.getExtensionForFormat(formatOption);
    }
    return path.extname(inputFile);
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
      throw new Error(`Invalid format: ${targetSize}`);
    }
    
    const value = parseFloat(match[1]);
    const unit = (match[2] || 'B').toUpperCase();
    
    return Math.floor(value * units[unit]);
  }
}

export { ImageCompressor };