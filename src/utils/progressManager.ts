import shcl from '@impulsedev/shcl';

export interface ProgressEntry {
  originalSize: number;
  compressedSize: number;
  [key: string]: unknown;
}

export interface ProgressStatistics {
  totalFiles: number;
  processedFiles: number;
  elapsedTime: number;
  totalOriginalSize: number;
  totalCompressedSize: number;
  totalReduction: string | number;
  averageReduction: string | number;
  spaceSaved: number;
  filesPerSecond: number;
}

export class ProgressManager {
  private readonly totalFiles: number;
  private processedFiles: number;
  private startTime: number;
  private totalOriginalSize: number;
  private totalCompressedSize: number;
  private readonly results: ProgressEntry[];

  constructor(totalFiles: number) {
    this.totalFiles = totalFiles;
    this.processedFiles = 0;
    this.startTime = Date.now();
    this.totalOriginalSize = 0;
    this.totalCompressedSize = 0;
    this.results = [];
  }

  update(fileName: string, result: ProgressEntry): void {
    this.processedFiles += 1;
    this.totalOriginalSize += result.originalSize;
    this.totalCompressedSize += result.compressedSize;
    this.results.push(result);

    this.displayProgress(fileName, result);
  }

  private displayProgress(fileName: string, result: ProgressEntry): void {
    const progress = ((this.processedFiles / this.totalFiles) * 100).toFixed(1);
    const reduction = ((result.originalSize - result.compressedSize) / result.originalSize * 100).toFixed(1);

    process.stdout.write('\r\x1b[K');
    process.stdout.write(
      `${shcl.cyan(`[${progress}%]`)} ${shcl.green('✓')} ${fileName} ${shcl.gray(`(-${reduction}%)`)}`
    );
  }

  getStats(): ProgressStatistics {
    const elapsedTime = Date.now() - this.startTime;
    const totalReduction =
      this.totalOriginalSize > 0
        ? ((this.totalOriginalSize - this.totalCompressedSize) / this.totalOriginalSize * 100).toFixed(2)
        : 0;

    return {
      totalFiles: this.totalFiles,
      processedFiles: this.processedFiles,
      elapsedTime,
      totalOriginalSize: this.totalOriginalSize,
      totalCompressedSize: this.totalCompressedSize,
      totalReduction,
      averageReduction: this.getAverageReduction(),
      spaceSaved: this.totalOriginalSize - this.totalCompressedSize,
      filesPerSecond: this.processedFiles === 0 ? 0 : this.processedFiles / (elapsedTime / 1000 || 1)
    };
  }

  private getAverageReduction(): string {
    if (this.results.length === 0) {
      return '0.00';
    }

    const reductions = this.results.map(result => ((result.originalSize - result.compressedSize) / result.originalSize) * 100);
    const average = reductions.reduce((sum, value) => sum + value, 0) / reductions.length;
    return average.toFixed(2);
  }

  private formatTime(milliseconds: number): string {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  }

  private formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';

    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  }

  displayFinalStats(): void {
    const stats = this.getStats();

    console.log(`\n${shcl.cyan('Final Statistics')}`);
    console.log(shcl.gray('─'.repeat(50)));
    console.log(`${shcl.green('✓')} Files processed: ${shcl.bold(stats.processedFiles)}/${stats.totalFiles}`);
    console.log(`Total time: ${shcl.bold(this.formatTime(stats.elapsedTime))}`);
    console.log(`Original size: ${shcl.bold(this.formatSize(stats.totalOriginalSize))}`);
    console.log(`Compressed size: ${shcl.bold(this.formatSize(stats.totalCompressedSize))}`);
    console.log(
      `Space saved: ${shcl.bold.green(this.formatSize(stats.spaceSaved))} ${shcl.gray(`(${stats.totalReduction}%)`)}`
    );
    console.log(`Average reduction: ${shcl.bold(stats.averageReduction)}%`);
    console.log(`Processing speed: ${shcl.bold(stats.filesPerSecond.toFixed(1))} files/sec`);
  }

  getProgressBar(current: number, total: number, width: number = 30): string {
    const progress = total === 0 ? 0 : current / total;
    const completed = Math.floor(progress * width);
    const remaining = width - completed;

    const bar = shcl.green('█'.repeat(completed)) + shcl.gray('░'.repeat(remaining));
    const percentage = (progress * 100).toFixed(1);

    return `[${bar}] ${percentage}%`;
  }

  estimateTimeRemaining(): number | null {
    if (this.processedFiles === 0) {
      return null;
    }

    const elapsedTime = Date.now() - this.startTime;
    const averageTimePerFile = elapsedTime / this.processedFiles;
    const remainingFiles = this.totalFiles - this.processedFiles;

    return remainingFiles * averageTimePerFile;
  }

  displayProgressBar(): void {
    const progressBar = this.getProgressBar(this.processedFiles, this.totalFiles);
    const timeRemaining = this.estimateTimeRemaining();

    process.stdout.write('\r\x1b[K');
    process.stdout.write(
      `${progressBar} ${this.processedFiles}/${this.totalFiles} files ${timeRemaining ? `ETA: ${this.formatTime(timeRemaining)}` : ''}`
    );
  }

  reset(): void {
    this.processedFiles = 0;
    this.startTime = Date.now();
    this.totalOriginalSize = 0;
    this.totalCompressedSize = 0;
    this.results.length = 0;
  }
}