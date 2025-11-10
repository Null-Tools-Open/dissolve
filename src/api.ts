import path from 'path';
import { promises as fs } from 'fs';
import os from 'os';
import { glob } from 'glob';
import mime from 'mime-types';

import { ImageCompressor } from './compressors/imageCompressor';
import { VideoCompressor } from './compressors/videoCompressor';
import { ThreadManager } from './utils/threadManager';
import { SystemWarnings } from './utils/systemWarnings';

export type CompressionStrategy = 'auto' | 'size' | 'quality' | 'speed';

export interface CompressionOptions {
  quality?: number | string;
  output?: string;
  format?: string;
  targetSize?: string | number;
  strategy?: CompressionStrategy;
  width?: number;
  height?: number;
  bitrate?: string;
  codec?: 'h264' | 'h265' | 'vp9' | 'av1';
  recursive?: boolean;
  progressive?: boolean;
  overwrite?: boolean;
  parallel?: number | string;
  threads?: number | string;
  ultrafast?: boolean;
  noOptimize?: boolean;
  multiThread?: boolean;
  forceThreads?: boolean;
  keepDimensions?: boolean;
  skip?: boolean;
}

interface ProcessedFile {
  inputFile: string;
  outputFile: string;
}

interface CompressionFileResult {
  inputFile: string;
  outputFile?: string | null;
  originalSize: number;
  compressedSize: number;
}

interface ThreadManagerFileResult {
  inputFile: string;
  outputFile: string;
}

interface ThreadManagerError {
  file: string;
  error: string;
  worker?: number;
}

interface ThreadManagerResult {
  processed: number;
  totalSizeReduction: number;
  errors: ThreadManagerError[];
  files?: ThreadManagerFileResult[];
}

interface FileGroups {
  images: string[];
  videos: string[];
  other: string[];
}

export interface CompressionResult {
  processed: number;
  totalSizeReduction: number;
  errors: Array<{ file: string; error: string }>;
  files: ProcessedFile[];
}

export interface AnalysisOptions {
  recursive?: boolean;
  detailed?: boolean;
}

interface AnalysisFileEntry {
  path: string;
  size: number;
  format: string;
  estimatedReduction: number;
  estimatedSize: number;
  recommendations: string[];
}

interface AnalysisSection {
  count: number;
  totalSize: number;
  estimatedReduction: number;
  files: AnalysisFileEntry[];
}

export interface AnalysisResult {
  totalFiles: number;
  totalSize: number;
  estimatedSavings: number;
  fileAnalysis: AnalysisFileEntry[];
}

export interface ConfigOptions {
  init?: boolean;
  show?: boolean;
  set?: string;
}

export interface DissolveConfig {
  image: {
    quality: number;
    format: string;
    progressive: boolean;
    optimization: boolean;
  };
  video: {
    codec: string;
    quality: string;
    audio: string;
    preset: string;
  };
  output: {
    suffix: string;
    overwrite: boolean;
    preserveStructure: boolean;
  };
  performance: {
    parallel: number;
    maxMemory: string;
  };
  advanced: {
    logLevel: string;
    showProgress: boolean;
    colorOutput: boolean;
  };
}

const CONFIG_FILE = '.dissolvec.json';

const DEFAULT_CONFIG: DissolveConfig = {
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

function cloneDefaultConfig(): DissolveConfig {
  return {
    image: { ...DEFAULT_CONFIG.image },
    video: { ...DEFAULT_CONFIG.video },
    output: { ...DEFAULT_CONFIG.output },
    performance: { ...DEFAULT_CONFIG.performance },
    advanced: { ...DEFAULT_CONFIG.advanced }
  };
}

export async function compress(input: string | string[], options: CompressionOptions = {}): Promise<CompressionResult> {
  const fileList = Array.isArray(input) ? input : [input];
  const mergedOptions: CompressionOptions = { ...options, skip: true };

  if (options.quality !== undefined) {
    const quality = parseInt(String(options.quality), 10);
    if (Number.isNaN(quality) || quality < 1 || quality > 100) {
      throw new Error('Quality must be a number between 1 and 100');
    }
  }

  if (options.threads !== undefined) {
    const threads = parseInt(String(options.threads), 10);
    if (Number.isNaN(threads) || threads < 1) {
      throw new Error('Threads must be a positive number');
    }
  }

  if (options.targetSize && typeof options.targetSize === 'string') {
    const targetSizeRegex = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i;
    if (!targetSizeRegex.test(options.targetSize)) {
      throw new Error('Target size must be in format like "4MB", "500KB", "1GB"');
    }
  }

  const resolvedFiles = await resolveFiles(fileList, options.recursive ?? false);
  if (resolvedFiles.length === 0) {
    throw new Error('No files found matching the pattern');
  }

  if (options.targetSize && resolvedFiles.length === 1) {
    await validateSingleFileTarget(resolvedFiles[0], options.targetSize);
  }

  if (!mergedOptions.parallel) {
    const cpuCores = os.cpus().length;
    mergedOptions.parallel = Math.max(cpuCores * 2, 8);
  }

  const fileGroups = await groupFilesByType(resolvedFiles);

  const imageCompressor = new ImageCompressor({
    ...mergedOptions,
    speedOptimized: Boolean(options.ultrafast),
    skipOptimizations: Boolean(options.noOptimize)
  });

  let videoCompressor: VideoCompressor | null = null;
  if (fileGroups.videos.length > 0) {
    videoCompressor = new VideoCompressor({
      ...mergedOptions,
      speedOptimized: Boolean(options.ultrafast),
      skipOptimizations: Boolean(options.noOptimize)
    });
  }

  const results: CompressionResult = {
    processed: 0,
    totalSizeReduction: 0,
    errors: [],
    files: []
  };

  const hasLargeFiles = await checkForLargeFiles(resolvedFiles);
  const useMultiThread = Boolean(
    options.multiThread ||
    options.forceThreads ||
    (resolvedFiles.length >= 4 && !options.parallel) ||
    hasLargeFiles
  );

  if (useMultiThread) {
    const optimizationOptions = {
      skip: mergedOptions.skip,
      ultrafast: mergedOptions.ultrafast,
      threads: mergedOptions.threads !== undefined ? Number(mergedOptions.threads) : undefined
    };
    await SystemWarnings.checkSystemOptimization(optimizationOptions);
  }

  if (options.keepDimensions) {
    delete mergedOptions.width;
    delete mergedOptions.height;
  }

  if (useMultiThread) {
    const threadManager = new ThreadManager(mergedOptions);

    if (fileGroups.images.length > 0) {
      const imageResults = await threadManager.processFiles(fileGroups.images, mergedOptions) as ThreadManagerResult;
      accumulateThreadResults(imageResults, results);
    }

    if (fileGroups.videos.length > 0 && videoCompressor) {
      const videoResults = await threadManager.processFiles(fileGroups.videos, mergedOptions) as ThreadManagerResult;
      accumulateThreadResults(videoResults, results);
    }
  } else {
    if (fileGroups.images.length > 0) {
      await processFilesSequential(fileGroups.images, imageCompressor, mergedOptions, results);
    }

    if (fileGroups.videos.length > 0 && videoCompressor) {
      await processFilesSequential(fileGroups.videos, videoCompressor, mergedOptions, results);
    }
  }

  return results;
}

async function validateSingleFileTarget(file: string, targetSize: string | number): Promise<void> {
  const stats = await fs.stat(file);
  const originalSize = stats.size;
  const target = targetSize.toString();
  const match = target.match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)?$/i);
  if (match) {
    const value = parseFloat(match[1]);
    const unit = (match[2] || 'B').toUpperCase();
    const multipliers: Record<string, number> = {
      B: 1,
      KB: 1024,
      MB: 1024 * 1024,
      GB: 1024 * 1024 * 1024
    };
    const targetBytes = Math.floor(value * multipliers[unit]);
    if (targetBytes >= originalSize) {
      const originalSizeMB = (originalSize / (1024 * 1024)).toFixed(2);
      const targetSizeMB = (targetBytes / (1024 * 1024)).toFixed(2);
      throw new Error(`Target size (${targetSizeMB}MB) must be smaller than original file (${originalSizeMB}MB)`);
    }
  }
}

async function resolveFiles(patterns: string[], recursive: boolean): Promise<string[]> {
  const allFiles = new Set<string>();

  for (const pattern of patterns) {
    try {
      const stat = await fs.stat(pattern);
      if (stat.isDirectory()) {
        const globPattern = recursive ? path.join(pattern, '**/*') : path.join(pattern, '*');
        const dirFiles = await glob(globPattern, { nodir: true });
        dirFiles.forEach(file => allFiles.add(file));
      } else {
        allFiles.add(pattern);
      }
    } catch {
      const globFiles = await glob(pattern, { nodir: true });
      globFiles.forEach(file => allFiles.add(file));
    }
  }

  return Array.from(allFiles).sort();
}

async function checkForLargeFiles(files: string[]): Promise<boolean> {
  const LARGE_FILE_THRESHOLD = 3 * 1024 * 1024 * 1024;

  for (const file of files) {
    try {
      const stats = await fs.stat(file);
      if (stats.size > LARGE_FILE_THRESHOLD) {
        return true;
      }
    } catch {
      // ignore
    }
  }

  return false;
}

async function groupFilesByType(files: string[]): Promise<FileGroups> {
  const groups: FileGroups = {
    images: [],
    videos: [],
    other: []
  };

  for (const file of files) {
    const mimeType = mime.lookup(file);
    if (typeof mimeType === 'string') {
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

async function processFilesSequential(
  files: string[],
  compressor: { compress(file: string, options: CompressionOptions): Promise<unknown> },
  options: CompressionOptions,
  results: CompressionResult
): Promise<void> {
  const parallelCandidate = options.parallel !== undefined ? Number(options.parallel) : 8;
  const parallel = Number.isFinite(parallelCandidate) && parallelCandidate > 0 ? Math.floor(parallelCandidate) : 8;

  let currentlyProcessing = 0;
  const maxConcurrent = parallel;

  const processFile = async (file: string): Promise<void> => {
    while (currentlyProcessing >= maxConcurrent) {
      await new Promise<void>(resolve => setTimeout(resolve, 1));
    }

    currentlyProcessing += 1;

    try {
      const result = await compressor.compress(file, options) as CompressionFileResult;
      results.processed += 1;
      results.totalSizeReduction += result.originalSize - result.compressedSize;

      if (result.outputFile) {
        results.files.push({
          inputFile: result.inputFile,
          outputFile: result.outputFile
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.errors.push({ file, error: message });
    } finally {
      currentlyProcessing -= 1;
    }
  };

  await Promise.all(files.map(processFile));
}

function accumulateThreadResults(source: ThreadManagerResult, target: CompressionResult): void {
  target.processed += source.processed;
  target.totalSizeReduction += source.totalSizeReduction;

  target.errors.push(
    ...source.errors.map(({ file, error }) => ({ file, error }))
  );

  if (source.files) {
    target.files.push(...source.files);
  }
}

export async function analyze(input: string | string[], options: AnalysisOptions = {}): Promise<AnalysisResult> {
  const fileList = Array.isArray(input) ? input : [input];
  const resolvedFiles = await resolveFiles(fileList, options.recursive ?? false);

  if (resolvedFiles.length === 0) {
    throw new Error('No files found matching the pattern');
  }

  const fileGroups = await groupFilesByType(resolvedFiles);

  const analysis = {
    images: await analyzeImages(fileGroups.images, options),
    videos: await analyzeVideos(fileGroups.videos, options),
    other: await analyzeOther(fileGroups.other)
  };

  let totalFiles = 0;
  let totalSize = 0;
  let totalEstimatedSavings = 0;
  const fileAnalysis: AnalysisFileEntry[] = [];

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

async function analyzeImages(imageFiles: string[], _options: AnalysisOptions): Promise<AnalysisSection | null> {
  if (imageFiles.length === 0) {
    return null;
  }

  const analysis: AnalysisSection = {
    count: imageFiles.length,
    totalSize: 0,
    estimatedReduction: 0,
    files: []
  };

  for (const file of imageFiles) {
    try {
      const stats = await fs.stat(file);
      const ext = path.extname(file).toLowerCase();
      const estimatedReduction = getImageCompressionEstimate(ext, stats.size);

      const fileAnalysis: AnalysisFileEntry = {
        path: file,
        size: stats.size,
        format: ext,
        estimatedReduction,
        estimatedSize: stats.size * (1 - estimatedReduction / 100),
        recommendations: getImageRecommendations(ext, stats.size)
      };

      analysis.files.push(fileAnalysis);
      analysis.totalSize += stats.size;
      analysis.estimatedReduction += stats.size * (estimatedReduction / 100);
    } catch {
      // ignore file errors during analysis
    }
  }

  return analysis;
}

async function analyzeVideos(videoFiles: string[], _options: AnalysisOptions): Promise<AnalysisSection | null> {
  if (videoFiles.length === 0) {
    return null;
  }

  const analysis: AnalysisSection = {
    count: videoFiles.length,
    totalSize: 0,
    estimatedReduction: 0,
    files: []
  };

  for (const file of videoFiles) {
    try {
      const stats = await fs.stat(file);
      const ext = path.extname(file).toLowerCase();
      const estimatedReduction = getVideoCompressionEstimate(ext, stats.size);

      const fileAnalysis: AnalysisFileEntry = {
        path: file,
        size: stats.size,
        format: ext,
        estimatedReduction,
        estimatedSize: stats.size * (1 - estimatedReduction / 100),
        recommendations: getVideoRecommendations(ext, stats.size)
      };

      analysis.files.push(fileAnalysis);
      analysis.totalSize += stats.size;
      analysis.estimatedReduction += stats.size * (estimatedReduction / 100);
    } catch {
      // ignore file errors during analysis
    }
  }

  return analysis;
}

async function analyzeOther(otherFiles: string[]): Promise<AnalysisSection | null> {
  if (otherFiles.length === 0) {
    return null;
  }

  return {
    count: otherFiles.length,
    totalSize: 0,
    estimatedReduction: 0,
    files: []
  };
}

function getImageCompressionEstimate(format: string, size: number): number {
  const estimates: Record<string, number> = {
    '.png': size > 5 * 1024 * 1024 ? 35 : 25,
    '.jpg': 15,
    '.jpeg': 15,
    '.bmp': 80,
    '.tiff': 60,
    '.webp': 5,
    '.gif': 25,
    '.avif': 3
  };

  return estimates[format] ?? 20;
}

function getVideoCompressionEstimate(format: string, _size: number): number {
  const estimates: Record<string, number> = {
    '.avi': 60,
    '.mov': 50,
    '.mkv': 30,
    '.mp4': 20,
    '.webm': 15,
    '.wmv': 55,
    '.flv': 65
  };

  return estimates[format] ?? 35;
}

function getImageRecommendations(format: string, size: number): string[] {
  const recommendations: string[] = [];

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

function getVideoRecommendations(format: string, size: number): string[] {
  const recommendations: string[] = [];

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

export async function config(options: ConfigOptions = {}): Promise<DissolveConfig> {
  const configPath = await getConfigPath();

  if (options.init) {
    if (await fileExists(configPath)) {
      throw new Error(`Configuration file already exists at: ${configPath}`);
    }

    const initialConfig = cloneDefaultConfig();
    await fs.writeFile(configPath, JSON.stringify(initialConfig, null, 2));
    return initialConfig;
  }

  if (options.show) {
    return loadConfig();
  }

  if (options.set) {
    const [keyPath, value] = options.set.split('=');

    if (!keyPath || value === undefined) {
      throw new Error('Invalid format. Use: key=value or section.key=value');
    }

    const currentConfig = await loadConfig();
    const keys = keyPath.split('.');

    if (keys.length === 1) {
      const [sectionKey] = keys as [keyof DissolveConfig];
      if (Object.prototype.hasOwnProperty.call(currentConfig, sectionKey)) {
        (currentConfig as unknown as Record<string, unknown>)[sectionKey as string] = parseValue(value);
      } else {
        throw new Error(`Unknown configuration key: ${sectionKey}`);
      }
    } else if (keys.length === 2) {
      const [section, key] = keys as [keyof DissolveConfig, string];
      const sectionValue = currentConfig[section];
      if (sectionValue && Object.prototype.hasOwnProperty.call(sectionValue, key)) {
        (sectionValue as Record<string, unknown>)[key] = parseValue(value);
      } else {
        throw new Error(`Unknown configuration key: ${keyPath}`);
      }
    } else {
      throw new Error('Configuration key path too deep. Maximum depth is 2 levels.');
    }

    await saveConfig(currentConfig);
    return currentConfig;
  }

  return loadConfig();
}

async function loadConfig(): Promise<DissolveConfig> {
  const configPath = await getConfigPath();

  try {
    if (await fileExists(configPath)) {
      const configData = await fs.readFile(configPath, 'utf8');
      const parsed = JSON.parse(configData) as Partial<DissolveConfig>;
      return mergeWithDefaults(parsed);
    }
  } catch {
    // ignore corrupted configuration
  }

  return cloneDefaultConfig();
}

async function saveConfig(config: DissolveConfig): Promise<void> {
  const configPath = await getConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
}

async function getConfigPath(): Promise<string> {
  const localConfig = path.join(process.cwd(), CONFIG_FILE);
  const homeConfig = path.join(os.homedir(), CONFIG_FILE);

  if (await fileExists(localConfig)) {
    return localConfig;
  }

  return homeConfig;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseValue(value: string): string | number | boolean {
  const numeric = Number(value);
  if (!Number.isNaN(numeric)) {
    return numeric;
  }

  const lowered = value.toLowerCase();
  if (lowered === 'true') {
    return true;
  }
  if (lowered === 'false') {
    return false;
  }

  return value;
}

function mergeWithDefaults(config: Partial<DissolveConfig>): DissolveConfig {
  return {
    image: { ...DEFAULT_CONFIG.image, ...(config.image ?? {}) },
    video: { ...DEFAULT_CONFIG.video, ...(config.video ?? {}) },
    output: { ...DEFAULT_CONFIG.output, ...(config.output ?? {}) },
    performance: { ...DEFAULT_CONFIG.performance, ...(config.performance ?? {}) },
    advanced: { ...DEFAULT_CONFIG.advanced, ...(config.advanced ?? {}) }
  };
}

export { DEFAULT_CONFIG };