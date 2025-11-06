const shcl = require('@impulsedev/shcl');

class ProgressManager {
  constructor(totalFiles) {
    this.totalFiles = totalFiles;
    this.processedFiles = 0;
    this.startTime = Date.now();
    this.totalOriginalSize = 0;
    this.totalCompressedSize = 0;
    this.results = [];
  }

  update(fileName, result) {
    this.processedFiles++;
    this.totalOriginalSize += result.originalSize;
    this.totalCompressedSize += result.compressedSize;
    this.results.push(result);
    
    this.displayProgress(fileName, result);
  }

  displayProgress(fileName, result) {
    const progress = ((this.processedFiles / this.totalFiles) * 100).toFixed(1);
    const reduction = ((result.originalSize - result.compressedSize) / result.originalSize * 100).toFixed(1);
    
    process.stdout.write('\r\x1b[K');
    process.stdout.write(
      `${shcl.cyan(`[${progress}%]`)} ` +
      `${shcl.green('✓')} ${fileName} ` +
      `${shcl.gray(`(-${reduction}%)`)}`
    );
  }

  getStats() {
    const elapsedTime = Date.now() - this.startTime;
    const totalReduction = this.totalOriginalSize > 0 
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
      filesPerSecond: this.processedFiles / (elapsedTime / 1000)
    };
  }

  getAverageReduction() {
    if (this.results.length === 0) return 0;
    
    const reductions = this.results.map(result => 
      ((result.originalSize - result.compressedSize) / result.originalSize * 100)
    );
    
    return (reductions.reduce((sum, reduction) => sum + reduction, 0) / reductions.length).toFixed(2);
  }

  formatTime(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  formatSize(bytes) {
    if (bytes === 0) return '0 B';
    
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  displayFinalStats() {
    const stats = this.getStats();
    
    console.log('\n' + shcl.cyan('Final Statistics'));
    console.log(shcl.gray('─'.repeat(50)));
    
    console.log(`${shcl.green('✓')} Files processed: ${shcl.bold(stats.processedFiles)}/${stats.totalFiles}`);
    console.log(`Total time: ${shcl.bold(this.formatTime(stats.elapsedTime))}`);
    console.log(`Original size: ${shcl.bold(this.formatSize(stats.totalOriginalSize))}`);
    console.log(`Compressed size: ${shcl.bold(this.formatSize(stats.totalCompressedSize))}`);
    console.log(`Space saved: ${shcl.bold.green(this.formatSize(stats.spaceSaved))} ${shcl.gray(`(${stats.totalReduction}%)`)}`);
    console.log(`Average reduction: ${shcl.bold(stats.averageReduction)}%`);
    console.log(`Processing speed: ${shcl.bold(stats.filesPerSecond.toFixed(1))} files/sec`);
  }

  getProgressBar(current, total, width = 30) {
    const progress = current / total;
    const completed = Math.floor(progress * width);
    const remaining = width - completed;
    
    const bar = shcl.green('█'.repeat(completed)) + shcl.gray('░'.repeat(remaining));
    const percentage = (progress * 100).toFixed(1);
    
    return `[${bar}] ${percentage}%`;
  }

  estimateTimeRemaining() {
    if (this.processedFiles === 0) return null;
    
    const elapsedTime = Date.now() - this.startTime;
    const averageTimePerFile = elapsedTime / this.processedFiles;
    const remainingFiles = this.totalFiles - this.processedFiles;
    
    return remainingFiles * averageTimePerFile;
  }

  displayProgressBar() {
    const progressBar = this.getProgressBar(this.processedFiles, this.totalFiles);
    const timeRemaining = this.estimateTimeRemaining();
    
    process.stdout.write('\r\x1b[K');
    process.stdout.write(
      `${progressBar} ` +
      `${this.processedFiles}/${this.totalFiles} files ` +
      (timeRemaining ? `ETA: ${this.formatTime(timeRemaining)}` : '')
    );
  }

  reset() {
    this.processedFiles = 0;
    this.startTime = Date.now();
    this.totalOriginalSize = 0;
    this.totalCompressedSize = 0;
    this.results = [];
  }
}

module.exports = { ProgressManager };