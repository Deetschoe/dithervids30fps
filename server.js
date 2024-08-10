const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const { exec } = require('child_process');
const crypto = require('crypto');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));
app.use(express.json());

// Preset palettes
const presetPalettes = {
  red: ['#FF0000', '#800000', '#400000', '#200000'],
  redMonochrome: ['#FF0000', '#BF0000', '#800000', '#400000'],
  greenMonochrome: ['#00FF00', '#00BF00', '#008000', '#004000'],
  green: ['#00FF00', '#008000', '#004000', '#002000'],
  blueMonochrome: ['#0000FF', '#0000BF', '#000080', '#000040'],
  blue: ['#0000FF', '#000080', '#000040', '#000020'],
  yellowMonochrome: ['#FFFF00', '#BFBF00', '#808000', '#404000'],
  yellow: ['#FFFF00', '#808000', '#404000', '#202000'],
  purpleGreen: ['#800080', '#008000', '#400040', '#004000'],
  yellowRed: ['#FFFF00', '#FF0000', '#808000', '#800000'],
  blueYellow: ['#0000FF', '#FFFF00', '#000080', '#808000'],
  blackWhite: ['#FFFFFF', '#AAAAAA', '#555555', '#000000'],
  rgby: ['#FF0000', '#00FF00', '#0000FF', '#FFFF00'],
  cmyk: ['#00FFFF', '#FF00FF', '#FFFF00', '#000000'],
  gameBoy: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'],
  blackWhiteRed: ['#FFFFFF', '#000000', '#FF0000']
};

// Check if FFmpeg is installed
exec('ffmpeg -version', (error, stdout, stderr) => {
  if (error) {
    console.error('FFmpeg is not installed or not in PATH. Please install FFmpeg.');
    process.exit(1);
  }
  console.log('FFmpeg is installed and accessible.');
});

async function ensureDirectoryExists(dir) {
  try {
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.access(dir, fs.constants.W_OK);
    console.log(`Directory ${dir} is accessible and writable`);
  } catch (error) {
    console.error(`Error with directory ${dir}:`, error);
    throw error;
  }
}

app.post('/upload', upload.array('videos'), async (req, res) => {
  try {
    console.log('Received upload request');
    console.log('Files:', req.files);
    console.log('Body:', req.body);

    const videos = req.files;
    const ditherIntensity = parseFloat(req.body.ditherIntensity);
    let palette;
    if (req.body.paletteType && presetPalettes[req.body.paletteType]) {
      palette = presetPalettes[req.body.paletteType];
    } else {
      palette = JSON.parse(req.body.palette);
    }
    const outputDir = path.join(__dirname, 'output');
    const framesDir = path.join(outputDir, 'frames');
    const uniqueId = crypto.randomBytes(8).toString('hex');
    const outputPath = path.join(outputDir, `output_${uniqueId}.mp4`);

    console.log('Processing parameters:', { ditherIntensity, palette, outputPath });

    await ensureDirectoryExists(outputDir);
    await ensureDirectoryExists(framesDir);

    for (let i = 0; i < videos.length; i++) {
      console.log(`Processing video ${i + 1} of ${videos.length}`);
      const video = videos[i];
      const videoFramesDir = path.join(framesDir, `video_${i}`);
      await ensureDirectoryExists(videoFramesDir);

      console.log('Extracting frames...');
      await extractFrames(video.path, videoFramesDir);

      console.log('Processing frames...');
      const frames = await fsPromises.readdir(videoFramesDir);
      for (const frame of frames.sort()) {
        const imagePath = path.join(videoFramesDir, frame);
        try {
          await applyDithering(imagePath, ditherIntensity, palette);
        } catch (error) {
          console.error(`Error processing frame ${frame}:`, error);
        }
      }

      console.log('Reconstructing video...');
      await reconstructVideo(videoFramesDir, outputPath);
    }

    console.log('Checking if output file exists...');
    try {
      await fsPromises.access(outputPath);
      const stats = await fsPromises.stat(outputPath);
      console.log(`Output file exists: ${outputPath}, Size: ${stats.size} bytes`);
      if (stats.size === 0) {
        throw new Error('Output file is empty');
      }
    } catch (error) {
      console.error('Error with output file:', error);
      throw new Error('Failed to create valid output file');
    }

    console.log('Cleaning up...');
    await fsPromises.rm(framesDir, { recursive: true });
    for (const video of videos) {
      await fsPromises.unlink(video.path);
    }

    console.log('Processing completed successfully');
    const response = { outputPath: `/download/${path.basename(outputPath)}` };
    console.log('Sending response:', response);
    res.json(response);
  } catch (error) {
    console.error('Error in /upload route:', error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

app.get('/download/:filename', (req, res) => {
  const file = path.join(__dirname, 'output', req.params.filename);
  console.log('Attempting to download file:', file);

  fsPromises.access(file, fs.constants.F_OK)
    .then(() => {
      console.log('File exists, starting download');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
      res.setHeader('Content-Type', 'video/mp4');

      const fileStream = fs.createReadStream(file);
      fileStream.pipe(res);

      fileStream.on('error', (error) => {
        console.error('Error streaming file:', error);
        if (!res.headersSent) {
          res.status(500).send('Error downloading file');
        }
      });

      fileStream.on('close', () => {
        console.log('File stream closed');
      });
    })
    .catch((err) => {
      console.error('File does not exist:', err);
      res.status(404).send('File not found');
    });
});

async function extractFrames(videoPath, outputDir) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .outputOptions('-vf fps=30')
      .output(path.join(outputDir, 'frame-%d.png'))
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

async function applyDithering(imagePath, intensity, palette) {
  console.log(`Applying dithering to ${imagePath}`);
  const paletteColors = palette.map(hex => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return [r, g, b];
  });

  let image;
  try {
    image = await sharp(imagePath).raw().toBuffer({ resolveWithObject: true });
  } catch (error) {
    console.error(`Error reading image ${imagePath}:`, error);
    throw error;
  }

  const { data, info } = image;
  const { width, height } = info;
  const newData = Buffer.alloc(data.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const oldR = data[i];
      const oldG = data[i + 1];
      const oldB = data[i + 2];

      const [newR, newG, newB] = findClosestColor(oldR, oldG, oldB, paletteColors);

      newData[i] = newR;
      newData[i + 1] = newG;
      newData[i + 2] = newB;

      const errorR = (oldR - newR) * intensity;
      const errorG = (oldG - newG) * intensity;
      const errorB = (oldB - newB) * intensity;

      distributeError(data, width, height, x, y, errorR, errorG, errorB);
    }
  }

  try {
    await sharp(newData, { raw: { width, height, channels: 3 } })
      .png()
      .toFile(imagePath);
    console.log(`Dithering applied to ${imagePath}`);
  } catch (error) {
    console.error(`Error saving dithered image ${imagePath}:`, error);
    throw error;
  }
}

function findClosestColor(r, g, b, palette) {
  let closestColor = palette[0];
  let minDistance = Number.MAX_VALUE;

  for (const color of palette) {
    const dr = r - color[0];
    const dg = g - color[1];
    const db = b - color[2];
    const distance = dr * dr + dg * dg + db * db;

    if (distance < minDistance) {
      minDistance = distance;
      closestColor = color;
    }
  }

  return closestColor;
}

function distributeError(data, width, height, x, y, errorR, errorG, errorB) {
  const distribute = (x, y, factor) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const i = (y * width + x) * 3;
    data[i] = Math.max(0, Math.min(255, data[i] + errorR * factor));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + errorG * factor));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + errorB * factor));
  };

  distribute(x + 1, y, 7 / 16);
  distribute(x - 1, y + 1, 3 / 16);
  distribute(x, y + 1, 5 / 16);
  distribute(x + 1, y + 1, 1 / 16);
}

async function reconstructVideo(framesDir, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(path.join(framesDir, 'frame-%d.png'))
      .inputOptions('-framerate 30')
      .outputOptions([
        '-c:v libx264',
        '-pix_fmt yuv420p',
        '-preset medium',
        '-crf 23',
        '-movflags +faststart'
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (!res.headersSent) {
    res.status(500).send('An unexpected error occurred');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});