const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

const ROOT = path.join(__dirname, '..');
const ICON_SVG = path.join(ROOT, 'build', 'icon.svg');
const BUILD_PNG = path.join(ROOT, 'build', 'icon.png');
const BUILD_ICO = path.join(ROOT, 'build', 'icon.ico');
const ASSETS_PNG = path.join(ROOT, 'src', 'assets', 'icon.png');
const ASSETS_ICO = path.join(ROOT, 'src', 'assets', 'icon.ico');

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = [];
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

function cornerIsTransparent(img) {
  const size = img.getSize();
  const bitmap = img.toBitmap();
  const points = [
    [0, 0],
    [size.width - 1, 0],
    [0, size.height - 1],
    [size.width - 1, size.height - 1],
  ];
  return points.every(([x, y]) => bitmap[(y * size.width + x) * 4 + 3] < 32);
}

async function render(svg, size, transparent) {
  const html = `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}
    svg{display:block;width:${size}px;height:${size}px}
  </style></head><body>${svg}</body></html>`;

  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent,
    backgroundColor: transparent ? '#00000000' : '#ffffff',
    webPreferences: { offscreen: true, sandbox: false },
  });

  await win.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(html));
  await new Promise((resolve) => setTimeout(resolve, 350));

  let image = await win.webContents.capturePage();
  win.destroy();

  const actual = image.getSize();
  if (actual.width !== size || actual.height !== size) {
    image = image.resize({ width: size, height: size, quality: 'best' });
  }
  return image;
}

app.whenReady().then(async () => {
  const svg = fs.readFileSync(ICON_SVG, 'utf8');
  const size = 512;

  let image = await render(svg, size, true);
  if (!cornerIsTransparent(image)) {
    image = await render(svg, size, false);
  }

  fs.writeFileSync(BUILD_PNG, image.toPNG());
  fs.writeFileSync(ASSETS_PNG, image.resize({ width: 512, height: 512, quality: 'best' }).toPNG());

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map((s) => ({
    size: s,
    png: image.resize({ width: s, height: s, quality: 'best' }).toPNG(),
  }));
  const ico = buildIco(images);
  fs.writeFileSync(BUILD_ICO, ico);
  fs.writeFileSync(ASSETS_ICO, ico);

  console.log('Icones gerados:', BUILD_PNG, BUILD_ICO, ASSETS_PNG, ASSETS_ICO);
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});

