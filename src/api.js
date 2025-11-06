const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const { glob } = require('glob');
const { filesize } = require('filesize');
const mime = require('mime-types');

const { ImageCompressor } = require('./compressors/imageCompressor');
const { VideoCompressor } = require('./compressors/videoCompressor');
const { ThreadManager } = require('./utils/threadManager');
const { SystemWarnings } = require('./utils/systemWarnings');

/**
 * @typedef {Object} CompressionOptions
 * @property {number} [quality=85] - Compression quality (1-100). Higher values = better quality but larger files.
 * @property {string} [output] - Output directory or file path. If not specified, files are compressed in-place.
 * @property {string} [format] - Output format (auto, jpg, png, webp, avif, mp4, mkv, etc.). Auto-detects best format if not specified.
 * @property {string} [targetSize] - Target file size (e.g., "200MB", "5MB", "1GB"). Tool will adjust compression to reach this size.
 * @property {'auto'|'size'|'quality'|'speed'} [strategy='auto'] - Compression strategy: "auto" (intelligent), "size" (smallest file), "quality" (best quality), "speed" (fastest processing).
 * @property {number} [width] - Target width for images/videos in pixels. Maintains aspect ratio if only width or height specified.
 * @property {number} [height] - Target height for images/videos in pixels. Maintains aspect ratio if only width or height specified.
 * @property {string} [bitrate] - Video bitrate (e.g., "1000k", "2M", "500k"). Controls video quality vs file size.
 * @property {'h264'|'h265'|'vp9'|'av1'} [codec] - Video codec ("h264", "h265", "vp9", "av1"). h264 = compatibility, h265/vp9 = efficiency.
 * @property {boolean} [recursive=false] - Process directories recursively. Scans all subdirectories for files.
 * @property {boolean} [progressive=false] - Enable progressive encoding for images. Better for web loading.
 * @property {boolean} [overwrite=false] - Overwrite existing files. WARNING: Not supported for video files.
 * @property {number} [parallel] - Number of parallel processes (default: auto-detect based on CPU cores). Higher = faster but more resource usage.
 * @property {number} [threads] - Number of worker threads for multi-core processing. Enables true parallel compression.
 * @property {boolean} [ultrafast=false] - Ultra-fast mode. Sacrifices quality for maximum speed. Good for batch processing.
 * @property {boolean} [noOptimize=false] - Skip advanced optimizations for maximum speed. Faster but less efficient compression.
 * @property {boolean} [multiThread=false] - Enable multi-threaded processing. Auto-enabled for 4+ files or files >3GB.
 * @property {boolean} [forceThreads=false] - Force multi-threading even for small file counts. Useful for consistent performance.
 * @property {boolean} [keepDimensions=false] - Keep original image/video dimensions. Ignores width/height/targetSize scaling.
 */

/**
 * @typedef {Object} CompressionResult
 * @property {number} processed - Number of files successfully processed
 * @property {number} totalSizeReduction - Total bytes saved across all files
 * @property {Array<{file: string, error: string}>} errors - List of files that failed to process with error messages
 * @property {Array<{inputFile: string, outputFile: string}>} files - List of processed files with input and output paths
 */

/**
 * Compress images, videos, and media files with advanced multi-threaded processing.
 * 
 * @param {string|string[]} files - File path, directory path, or array of paths/patterns to compress
 * @param {CompressionOptions} [options] - Compression configuration options
 * @returns {Promise<CompressionResult>} Promise resolving to compression results with statistics
 */
async function compress(files, options = {}) {
  const fileList = Array.isArray(files) ? files : [files];
  const mergedOptions = { ...options, skip: true };
  
  if (options.quality !== undefined) {
    const quality = parseInt(options.quality);
    if (isNaN(quality) || quality < 1 || quality > 100) {
      throw new Error('Quality must be a number between 1 and 100');
    }
  }
  
  if (options.threads !== undefined) {
    const threads = parseInt(options.threads);
    if (isNaN(threads) || threads < 1) {
      throw new Error('Threads must be a positive number');
    }
  }
  
  if (options.targetSize && typeof options.targetSize === 'string') {
    const targetSizeRegex = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i;
    if (!targetSizeRegex.test(options.targetSize)) {
      throw new Error('Target size must be in format like "4MB", "500KB", "1GB"');
    }
  }

  const resolvedFiles = await resolveFiles(fileList, options.recursive);
  
  if (resolvedFiles.length === 0) {
    throw new Error('No files found matching the pattern');
  }

  if (options.targetSize && resolvedFiles.length === 1) {
    try {
      const fileStats = await fs.stat(resolvedFiles[0]);
      const originalSize = fileStats.size;
      
      const match = options.targetSize.toString().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i);
      if (match) {
        const value = parseFloat(match[1]);
        const unit = (match[2] || 'B').toUpperCase();
        const multipliers = { 'B': 1, 'KB': 1024, 'MB': 1024 * 1024, 'GB': 1024 * 1024 * 1024 };
        const targetBytes = Math.floor(value * multipliers[unit]);
        
        if (targetBytes >= originalSize) {
          const originalSizeMB = (originalSize / (1024 * 1024)).toFixed(2);
          const targetSizeMB = (targetBytes / (1024 * 1024)).toFixed(2);
          throw new Error(`Target size (${targetSizeMB}MB) must be smaller than original file (${originalSizeMB}MB)`);
        }
      }
    } catch (error) {
      if (error.message.includes('Target size')) {
        throw error;
      }
    }
  }

  if (!mergedOptions.parallel) {
    const cpuCores = os.cpus().length;
    mergedOptions.parallel = Math.max(cpuCores * 2, 8);
  }

  const fileGroups = await groupFilesByType(resolvedFiles);
  
  const imageCompressor = new ImageCompressor({
    ...mergedOptions,
    speedOptimized: options.ultrafast || false,
    skipOptimizations: options.noOptimize || false
  });
  
  let videoCompressor = null;
  if (fileGroups.videos.length > 0) {
    videoCompressor = new VideoCompressor({
      ...mergedOptions,
      speedOptimized: options.ultrafast || false,
      skipOptimizations: options.noOptimize || false
    });
  }
  
  const results = {
    processed: 0,
    totalSizeReduction: 0,
    errors: [],
    files: []
  };

  const hasLargeFiles = await checkForLargeFiles(resolvedFiles);
  
  const useMultiThread = options.multiThread || 
                         options.forceThreads || 
                         (resolvedFiles.length >= 4 && !options.parallel) ||
                         hasLargeFiles;

  if (useMultiThread) {
    await SystemWarnings.checkSystemOptimization(mergedOptions);
  }

  if (options.keepDimensions) {
    delete mergedOptions.width;
    delete mergedOptions.height;
  }

  if (useMultiThread) {
    const threadManager = new ThreadManager(mergedOptions);
    
    if (fileGroups.images.length > 0) {
      const imageResults = await threadManager.processFiles(fileGroups.images, mergedOptions);
      results.processed += imageResults.processed;
      results.totalSizeReduction += imageResults.totalSizeReduction;
      results.errors.push(...imageResults.errors);
      if (imageResults.files) {
        results.files.push(...imageResults.files);
      }
    }

    if (fileGroups.videos.length > 0) {
      const videoResults = await threadManager.processFiles(fileGroups.videos, mergedOptions);
      results.processed += videoResults.processed;
      results.totalSizeReduction += videoResults.totalSizeReduction;
      results.errors.push(...videoResults.errors);
      if (videoResults.files) {
        results.files.push(...videoResults.files);
      }
    }
  } else {
    if (fileGroups.images.length > 0) {
      await processFiles(fileGroups.images, imageCompressor, mergedOptions, results);
    }

    if (fileGroups.videos.length > 0) {
      if (videoCompressor) {
        await processFiles(fileGroups.videos, videoCompressor, mergedOptions, results);
      }
    }
  }

  return results;
}

async function resolveFiles(patterns, recursive) {
  const allFiles = [];
  
  for (const pattern of patterns) {
    try {
      const stat = await fs.stat(pattern);
      
      if (stat.isDirectory()) {
        const globPattern = recursive 
          ? path.join(pattern, '**/*')
          : path.join(pattern, '*');
        
        const dirFiles = await glob(globPattern, { nodir: true });
        allFiles.push(...dirFiles);
      } else {
        allFiles.push(pattern);
      }
    } catch (error) {
      const globFiles = await glob(pattern, { nodir: true });
      allFiles.push(...globFiles);
    }
  }
  
  return [...new Set(allFiles)].sort();
}

async function checkForLargeFiles(files) {
  const LARGE_FILE_THRESHOLD = 3 * 1024 * 1024 * 1024;
  
  for (const file of files) {
    try {
      const stats = await fs.stat(file);
      if (stats.size > LARGE_FILE_THRESHOLD) {
        return true;
      }
    } catch (error) {
      continue;
    }
  }
  
  return false;
}

async function groupFilesByType(files) {
  const groups = {
    images: [],
    videos: [],
    other: []
  };

  for (const file of files) {
    const mimeType = mime.lookup(file);
    
    if (mimeType) {
      if (mimeType.startsWith('image/')) {
        groups.images.push(file);
      } else if (mimeType.startsWith('video/')) {
        groups.videos.push(file);
      } else {
        groups.other.push(file);
      }
    } else {
      groups.other.push(file);
    }
  }

  return groups;
}

async function processFiles(files, compressor, options, results) {
  const parallel = parseInt(options.parallel) || 8;

  let currentlyProcessing = 0;
  const maxConcurrent = parallel;
  
  const processFile = async (file) => {
    while (currentlyProcessing >= maxConcurrent) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    
    currentlyProcessing++;
    
    try {
      const result = await compressor.compress(file, options);
      
      results.processed++;
      results.totalSizeReduction += (result.originalSize - result.compressedSize);
      
      if (result.outputFile) {
        results.files.push({
          inputFile: result.inputFile,
          outputFile: result.outputFile
        });
      }
      
    } catch (error) {
      results.errors.push({ file, error: error.message });
    } finally {
      currentlyProcessing--;
    }
  };

  const promises = files.map(processFile);
  await Promise.all(promises);
}

/**
 * @typedef {Object} AnalysisOptions
 * @property {boolean} [recursive=false] - Analyze directories recursively
 * @property {boolean} [detailed=false] - Show detailed analysis with recommendations
 */

/**
 * @typedef {Object} AnalysisResult
 * @property {number} totalFiles - Total number of files analyzed
 * @property {number} totalSize - Total size of all files in bytes
 * @property {number} estimatedSavings - Estimated bytes that could be saved
 * @property {Array<Object>} fileAnalysis - Detailed analysis per file
 */

/**
 * Analyze files and estimate compression potential without actually compressing them.
 * Provides insights into file sizes, formats, and potential space savings.
 * 
 * @param {string|string[]} files - File path, directory path, or array of paths/patterns to analyze
 * @param {AnalysisOptions} [options] - Analysis configuration options
 * @returns {Promise<AnalysisResult>} Promise resolving to analysis results with estimates
 */
async function analyze(files, options = {}) {
  const fileList = Array.isArray(files) ? files : [files];
  const resolvedFiles = await resolveFiles(fileList, options.recursive);
  
  if (resolvedFiles.length === 0) {
    throw new Error('No files found matching the pattern');
  }

  const fileGroups = await groupFilesByType(resolvedFiles);
  
  const analysis = {
    images: await analyzeImages(fileGroups.images, options),
    videos: await analyzeVideos(fileGroups.videos, options),
    other: await analyzeOther(fileGroups.other, options)
  };
  
  let totalFiles = 0;
  let totalSize = 0;
  let totalEstimatedSavings = 0;
  const fileAnalysis = [];
  
  if (analysis.images) {
    totalFiles += analysis.images.count;
    totalSize += analysis.images.totalSize;
    totalEstimatedSavings += analysis.images.estimatedReduction;
    fileAnalysis.push(...analysis.images.files);
  }
  
  if (analysis.videos) {
    totalFiles += analysis.videos.count;
    totalSize += analysis.videos.totalSize;
    totalEstimatedSavings += analysis.videos.estimatedReduction;
    fileAnalysis.push(...analysis.videos.files);
  }
  
  if (analysis.other) {
    totalFiles += analysis.other.count;
    fileAnalysis.push(...analysis.other.files);
  }

  return {
    totalFiles,
    totalSize,
    estimatedSavings: totalEstimatedSavings,
    fileAnalysis
  };
}

async function analyzeImages(imageFiles, options) {
  if (imageFiles.length === 0) return null;
  
  const analysis = {
    count: imageFiles.length,
    totalSize: 0,
    estimatedReduction: 0,
    files: []
  };
  
  for (const file of imageFiles) {
    try {
      const stats = await fs.stat(file);
      const ext = path.extname(file).toLowerCase();
      
      let estimatedReduction = getImageCompressionEstimate(ext, stats.size);
      
      const fileAnalysis = {
        path: file,
        size: stats.size,
        format: ext,
        estimatedReduction,
        estimatedSize: stats.size * (1 - estimatedReduction / 100),
        recommendations: getImageRecommendations(ext, stats.size)
      };
      
      analysis.files.push(fileAnalysis);
      analysis.totalSize += stats.size;
      analysis.estimatedReduction += (stats.size * estimatedReduction / 100);
      
    } catch (error) {
    }
  }
  
  return analysis;
}

async function analyzeVideos(videoFiles, options) {
  if (videoFiles.length === 0) return null;
  
  const analysis = {
    count: videoFiles.length,
    totalSize: 0,
    estimatedReduction: 0,
    files: []
  };
  
  for (const file of videoFiles) {
    try {
      const stats = await fs.stat(file);
      const ext = path.extname(file).toLowerCase();
      
      let estimatedReduction = getVideoCompressionEstimate(ext, stats.size);
      
      const fileAnalysis = {
        path: file,
        size: stats.size,
        format: ext,
        estimatedReduction,
        estimatedSize: stats.size * (1 - estimatedReduction / 100),
        recommendations: getVideoRecommendations(ext, stats.size)
      };
      
      analysis.files.push(fileAnalysis);
      analysis.totalSize += stats.size;
      analysis.estimatedReduction += (stats.size * estimatedReduction / 100);
      
    } catch (error) {
    }
  }
  
  return analysis;
}

async function analyzeOther(otherFiles, options) {
  if (otherFiles.length === 0) return null;
  
  return {
    count: otherFiles.length,
    totalSize: 0,
    estimatedReduction: 0,
    files: []
  };
}

function getImageCompressionEstimate(format, size) {
  const estimates = {
    '.png': size > 5 * 1024 * 1024 ? 35 : 25,
    '.jpg': 15,
    '.jpeg': 15,
    '.bmp': 80,
    '.tiff': 60,
    '.webp': 5,
    '.gif': 25,
    '.avif': 3
  };
  
  return estimates[format] || 20;
}

function getVideoCompressionEstimate(format, size) {
  const estimates = {
    '.avi': 60,
    '.mov': 50,
    '.mkv': 30,
    '.mp4': 20,
    '.webm': 15,
    '.wmv': 55,
    '.flv': 65
  };
  
  return estimates[format] || 35;
}

function getImageRecommendations(format, size) {
  const recommendations = [];
  
  if (format === '.png' && size > 1024 * 1024) {
    recommendations.push('Consider converting to JPEG or WebP for better compression');
  }
  
  if (format === '.bmp') {
    recommendations.push('BMP format is uncompressed - convert to JPEG/PNG for significant savings');
  }
  
  if (size > 10 * 1024 * 1024) {
    recommendations.push('Large file - consider reducing resolution or quality');
  }
  
  if (format === '.jpg' || format === '.jpeg') {
    recommendations.push('Try progressive JPEG or WebP format');
  }
  
  return recommendations;
}

function getVideoRecommendations(format, size) {
  const recommendations = [];
  
  if (format === '.avi' || format === '.mov') {
    recommendations.push('Convert to MP4 with H.264 codec for better compression');
  }
  
  if (size > 1024 * 1024 * 1024) {
    recommendations.push('Large file - consider reducing bitrate or resolution');
  }
  
  if (format === '.wmv' || format === '.flv') {
    recommendations.push('Legacy format - convert to modern codec (H.264/H.265)');
  }
  
  return recommendations;
}

/**
 * @typedef {Object} ConfigOptions
 * @property {boolean} [init=false] - Initialize default configuration
 * @property {boolean} [show=false] - Show current configuration
 * @property {string} [set] - Set configuration value (format: "key=value")
 */

const CONFIG_FILE = '.dissolvec.json';

const DEFAULT_CONFIG = {
  image: {
    quality: 85,
    format: 'auto',
    progressive: true,
    optimization: true
  },
  video: {
    codec: 'h264',
    quality: 'medium',
    audio: 'aac',
    preset: 'fast'
  },
  output: {
    suffix: '_compressed',
    overwrite: false,
    preserveStructure: true
  },
  performance: {
    parallel: 4,
    maxMemory: '1GB'
  },
  advanced: {
    logLevel: 'info',
    showProgress: true,
    colorOutput: true
  }
};

/**
 * Manage dissolve configuration settings. Set default compression options,
 * thread counts, and other preferences that persist across sessions.
 * 
 * @param {ConfigOptions} [options] - Configuration management options
 * @returns {Promise<Object|void>} Promise resolving to configuration object or void
 */
async function config(options = {}) {
  const configPath = await getConfigPath();
  
  if (options.init) {
    try {
      if (await fileExists(configPath)) {
        throw new Error(`Configuration file already exists at: ${configPath}`);
      }
      
      await fs.writeFile(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
      return DEFAULT_CONFIG;
    } catch (error) {
      throw new Error(`Failed to create configuration file: ${error.message}`);
    }
  } else if (options.show) {
    return await loadConfig();
  } else if (options.set) {
    const [keyPath, value] = options.set.split('=');
    
    if (!keyPath || value === undefined) {
      throw new Error('Invalid format. Use: key=value or section.key=value');
    }
    
    const config = await loadConfig();
    const keys = keyPath.split('.');
    
    if (keys.length === 1) {
      if (config.hasOwnProperty(keys[0])) {
        config[keys[0]] = parseValue(value);
      } else {
        throw new Error(`Unknown configuration key: ${keys[0]}`);
      }
    } else if (keys.length === 2) {
      const [section, key] = keys;
      
      if (config[section] && config[section].hasOwnProperty(key)) {
        config[section][key] = parseValue(value);
      } else {
        throw new Error(`Unknown configuration key: ${keyPath}`);
      }
    } else {
      throw new Error('Configuration key path too deep. Maximum depth is 2 levels.');
    }
    
    await saveConfig(config);
    return config;
  }
  
  return await loadConfig();
}

async function loadConfig() {
  const configPath = await getConfigPath();
  
  try {
    if (await fileExists(configPath)) {
      const configData = await fs.readFile(configPath, 'utf8');
      const config = JSON.parse(configData);
      
      return mergeWithDefaults(config);
    } else {
      return DEFAULT_CONFIG;
    }
  } catch (error) {
    return DEFAULT_CONFIG;
  }
}

async function saveConfig(config) {
  const configPath = await getConfigPath();
  
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

async function getConfigPath() {
  const localConfig = path.join(process.cwd(), CONFIG_FILE);
  const homeConfig = path.join(os.homedir(), CONFIG_FILE);
  
  if (await fileExists(localConfig)) {
    return localConfig;
  }
  
  return homeConfig;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseValue(value) {
  if (!isNaN(value) && !isNaN(parseFloat(value))) {
    return parseFloat(value);
  }
  
  if (value.toLowerCase() === 'true') {
    return true;
  }
  if (value.toLowerCase() === 'false') {
    return false;
  }
  
  return value;
}

function mergeWithDefaults(config) {
  const merged = { ...DEFAULT_CONFIG };
  
  for (const [section, values] of Object.entries(config)) {
    if (merged[section] && typeof values === 'object') {
      merged[section] = { ...merged[section], ...values };
    } else {
      merged[section] = values;
    }
  }
  
  return merged;
}

module.exports = {
  compress,
  analyze,
  config,
};