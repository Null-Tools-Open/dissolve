const os = require('os');
const fs = require('fs').promises;
const shcl = require('@impulsedev/shcl');

class SystemWarnings {
  static async checkSystemOptimization(options = {}) {
    const warnings = [];
    const isQuiet = options.skip || false;
    
    const cpuCores = os.cpus().length;
    const threadCount = options.threads || (options.ultrafast ? cpuCores : Math.floor(cpuCores * 0.75));
    
    if (threadCount > cpuCores * 1.5) {
      warnings.push({
        type: 'over-subscription',
        message: `Warning: ${threadCount} workers > ${cpuCores} CPU cores may cause context switching overhead`,
        severity: 'medium'
      });
    }
    
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const memoryUsagePercent = ((totalMemory - freeMemory) / totalMemory) * 100;
    
    if (memoryUsagePercent > 85) {
      warnings.push({
        type: 'memory',
        message: `Warning: High memory usage (${memoryUsagePercent.toFixed(1)}%) may impact multi-threading performance`,
        severity: 'high'
      });
    }
    
    try {
      const diskInfo = await SystemWarnings.checkDiskType();
      if (diskInfo.isHDD) {
        warnings.push({
          type: 'disk-io',
          message: 'Warning: HDD detected - disk I/O may become bottleneck with many parallel operations',
          severity: 'low'
        });
      }
    } catch (error) {
    }
    return warnings;
  }
  
  static async checkDiskType() {
    try {
      if (process.platform === 'win32') {
        const start = Date.now();
        await fs.access('.');
        const accessTime = Date.now() - start;
        
        return {
          isHDD: accessTime > 2,
          accessTime
        };
      }
    } catch (error) {
    }
    
    return { isHDD: false, accessTime: 0 };
  }
  
  static getOptimalSettings(systemInfo = {}) {
    const cpuCores = os.cpus().length;
    const totalMemory = os.totalmem();
    
    const recommendations = {
      threads: Math.min(cpuCores, 16),
      memoryWarning: totalMemory < 8 * 1024 * 1024 * 1024,
      cpuIntensive: cpuCores >= 8,
      suggestions: []
    };
    
    if (cpuCores >= 16) {
      recommendations.suggestions.push('High-end CPU detected: Consider --ultrafast --threads 16 for maximum speed');
    } else if (cpuCores >= 8) {
      recommendations.suggestions.push('Multi-core CPU: --ultrafast --threads 8 recommended');
    } else {
      recommendations.suggestions.push('Lower core count: --threads 4 may be optimal');
    }
    
    if (recommendations.memoryWarning) {
      recommendations.suggestions.push('Limited RAM: Process files in smaller batches');
    }
    
    return recommendations;
  }
}

module.exports = { SystemWarnings };