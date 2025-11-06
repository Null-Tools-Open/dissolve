const sharp = require('sharp');
const fs = require('fs').promises;
const path = require('path');

const MIN_FRAGMENT_SIZE = 100 * 1024 * 1024;
const MIN_FRAGMENTS = 2;

async function splitLargeImagesIntoFragments(files, threadCount, options) {
  const result = [];
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp', '.avif', '.bmp', '.tiff'].includes(ext)) {
      result.push(file);
      continue;
    }
    const stat = await fs.stat(file);
    if (stat.size < MIN_FRAGMENT_SIZE) {
      result.push(file);
      continue;
    }
    const fragments = Math.max(MIN_FRAGMENTS, threadCount);
    const image = sharp(file);
    const metadata = await image.metadata();
    const fragmentHeight = Math.floor(metadata.height / fragments);
    for (let i = 0; i < fragments; i++) {
      const top = i * fragmentHeight;
      const height = (i === fragments - 1) ? (metadata.height - top) : fragmentHeight;
      const buffer = await sharp(file)
        .extract({ left: 0, top, width: metadata.width, height })
        .toBuffer();
      result.push({
        buffer,
        fragmentIndex: i,
        totalFragments: fragments,
        originalFile: file,
        ext
      });
    }
  }
  return result;
}

module.exports = { splitLargeImagesIntoFragments };