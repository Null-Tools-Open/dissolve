interface CompressionOptions {
  /** Compression quality (1-100). Higher values = better quality but larger files. */
  quality?: number;
  /** Skip errors, logging and dissolve ascii logo. Quiet mode for automated scripts. */
  skip?: boolean;
  /** Output directory or file path. If not specified, files are compressed in-place. */
  output?: string;
  /** Output format (auto, jpg, png, webp, avif, mp4, mkv, etc.). Auto-detects best format if not specified. */
  format?: string;
  /** Target file size (e.g., "200MB", "5MB", "1GB"). Tool will adjust compression to reach this size. */
  targetSize?: string;
  /** Compression strategy: "auto" (intelligent), "size" (smallest file), "quality" (best quality), "speed" (fastest processing). */
  strategy?: 'auto' | 'size' | 'quality' | 'speed';
  /** Target width for images/videos in pixels. Maintains aspect ratio if only width or height specified. */
  width?: number;
  /** Target height for images/videos in pixels. Maintains aspect ratio if only width or height specified. */
  height?: number;
  /** Video bitrate (e.g., "1000k", "2M", "500k"). Controls video quality vs file size. */
  bitrate?: string;
  /** Video codec ("h264", "h265", "vp9", "av1"). h264 = compatibility, h265/vp9 = efficiency. */
  codec?: 'h264' | 'h265' | 'vp9' | 'av1';
  /** Process directories recursively. Scans all subdirectories for files. */
  recursive?: boolean;
  /** Enable progressive encoding for images. Better for web loading. */
  progressive?: boolean;
  /** Overwrite existing files. WARNING: Not supported for video files. */
  overwrite?: boolean;
  /** Number of parallel processes (default: auto-detect based on CPU cores). Higher = faster but more resource usage. */
  parallel?: number;
  /** Number of worker threads for multi-core processing. Enables true parallel compression. */
  threads?: number;
  /** Ultra-fast mode. Sacrifices quality for maximum speed. Good for batch processing. */
  ultrafast?: boolean;
  /** Skip advanced optimizations for maximum speed. Faster but less efficient compression. */
  noOptimize?: boolean;
  /** Enable multi-threaded processing. Auto-enabled for 4+ files or files >3GB. */
  multiThread?: boolean;
  /** Force multi-threading even for small file counts. Useful for consistent performance. */
  forceThreads?: boolean;
  /** Keep original image/video dimensions. Ignores width/height/targetSize scaling. */
  keepDimensions?: boolean;
}

interface CompressionResult {
  /** Number of files successfully processed */
  processed: number;
  /** Total bytes saved across all files */
  totalSizeReduction: number;
  /** List of files that failed to process with error messages */
  errors: Array<{ file: string; error: string }>;
}

interface AnalysisOptions {
  /** Analyze directories recursively */
  recursive?: boolean;
  /** Show detailed analysis with recommendations */
  detailed?: boolean;
}

interface AnalysisResult {
  /** Total number of files analyzed */
  totalFiles: number;
  /** Total size of all files in bytes */
  totalSize: number;
  /** Estimated bytes that could be saved */
  estimatedSavings: number;
  /** Detailed analysis per file */
  fileAnalysis: Array<object>;
}

interface ConfigOptions {
  /** Initialize default configuration */
  init?: boolean;
  /** Show current configuration */
  show?: boolean;
  /** Set configuration value (format: "key=value") */
  set?: string;
}



declare namespace dissolve {
  /**
   * Compress images, videos, and media files with advanced multi-threaded processing.
   * 
   * Supports formats:
   * - Images: JPG, PNG, WebP, AVIF, BMP, TIFF, GIF
   * - Videos: MP4, AVI, MOV, MKV, WebM, WMV, FLV
   * 
   * Features:
   * - Multi-threaded processing for large files and batches
   * - Intelligent compression strategies
   * - Target size optimization
   * - Format conversion and optimization
   * - Batch processing with progress tracking
   */
  function compress(files: string | string[], options?: CompressionOptions): Promise<CompressionResult>;
  
  /**
   * Analyze files and estimate compression potential without actually compressing them.
   * Provides insights into file sizes, formats, and potential space savings.
   */
  function analyze(files: string | string[], options?: AnalysisOptions): Promise<AnalysisResult>;
  
  /**
   * Manage dissolve configuration settings. Set default compression options,
   * thread counts, and other preferences that persist across sessions.
   */
  function config(options?: ConfigOptions): Promise<void>;
}

export = dissolve;