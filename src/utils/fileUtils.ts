import { promises as fsPromises, createReadStream, createWriteStream, Stats } from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

type ProgressCallback = (copiedBytes: number, totalBytes: number) => void;

interface DiskSpaceInfo {
  total: number;
  free: number;
  used: number;
}

type ChunkProcessor = (chunk: Buffer) => void | Promise<void>;

const fs = fsPromises;

export class FileUtils {
  static async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  static async getFileSize(filePath: string): Promise<number> {
    const stats = await fs.stat(filePath);
    return stats.size;
  }

  static async ensureDir(dirPath: string): Promise<void> {
    try {
      await fs.mkdir(dirPath, { recursive: true });
    } catch (error: any) {
      if (error.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  static async copyFile(source: string, destination: string, onProgress?: ProgressCallback): Promise<void> {
    await this.ensureDir(path.dirname(destination));

    const sourceSize = await this.getFileSize(source);
    let copiedBytes = 0;

    const sourceStream = createReadStream(source);
    const destStream = createWriteStream(destination);

    sourceStream.on('data', (chunk: Buffer) => {
      copiedBytes += chunk.length;
      if (onProgress) {
        onProgress(copiedBytes, sourceSize);
      }
    });

    await pipeline(sourceStream, destStream);
  }

  static async moveFile(source: string, destination: string): Promise<void> {
    await this.ensureDir(path.dirname(destination));
    await fs.rename(source, destination);
  }

  static async deleteFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  static getExtension(filePath: string): string {
    return path.extname(filePath).toLowerCase();
  }

  static getBaseName(filePath: string): string {
    return path.basename(filePath, path.extname(filePath));
  }

  static async getUniqueFileName(filePath: string): Promise<string> {
    if (!(await this.exists(filePath))) {
      return filePath;
    }

    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);

    let counter = 1;
    let newPath: string;

    do {
      newPath = path.join(dir, `${base}_${counter}${ext}`);
      counter++;
    } while (await this.exists(newPath));

    return newPath;
  }

  static formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  }

  static getCompressionRatio(originalSize: number, compressedSize: number): string {
    if (originalSize === 0) return '0.00';
    return ((originalSize - compressedSize) / originalSize * 100).toFixed(2);
  }

  static validatePath(filePath: string): true {
    const invalidChars = /[<>:"|?*]/;
    if (invalidChars.test(filePath)) {
      throw new Error(`Invalid characters in file path: ${filePath}`);
    }

    if (filePath.length > 260) {
      throw new Error(`File path too long: ${filePath}`);
    }

    return true;
  }

  static getSafeFileName(fileName: string): string {
    return fileName
      .replace(/[<>:"|?*]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_{2,}/g, '_')
      .trim();
  }

  static getRelativePath(from: string, to: string): string {
    return path.relative(from, to);
  }

  static isAbsolute(filePath: string): boolean {
    return path.isAbsolute(filePath);
  }

  static normalizePath(filePath: string): string {
    return path.normalize(filePath);
  }

  static async getFileStats(filePath: string): Promise<{
    size: number;
    created: Date;
    modified: Date;
    accessed: Date;
    isFile: boolean;
    isDirectory: boolean;
    permissions: number;
    formattedSize: string;
  }> {
    const stats: Stats = await fs.stat(filePath);

    return {
      size: stats.size,
      created: stats.birthtime,
      modified: stats.mtime,
      accessed: stats.atime,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      permissions: stats.mode,
      formattedSize: this.formatFileSize(stats.size)
    };
  }

  static async readFileInChunks(filePath: string, chunkSize: number = 64 * 1024, processor: ChunkProcessor): Promise<void> {
    const stream = createReadStream(filePath, { highWaterMark: chunkSize });

    for await (const chunk of stream) {
      await processor(chunk as Buffer);
    }
  }

  static async getDiskSpace(dirPath: string): Promise<DiskSpaceInfo> {
    try {
      const fsAny = fs as unknown as { statvfs?: (path: string) => Promise<{ f_blocks: number; f_frsize: number; f_bavail: number }> };
      if (!fsAny.statvfs) {
        throw new Error('statvfs not available');
      }

      const stats = await fsAny.statvfs(dirPath);

      return {
        total: stats.f_blocks * stats.f_frsize,
        free: stats.f_bavail * stats.f_frsize,
        used: (stats.f_blocks - stats.f_bavail) * stats.f_frsize
      };
    } catch {
      return {
        total: 0,
        free: 0,
        used: 0
      };
    }
  }
}