const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'app', 'static');
const h5Html = fs.readFileSync(path.join(root, 'h5.html'), 'utf8');
const h5Js = fs.readFileSync(path.join(root, 'h5.js'), 'utf8');
const desktopHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const desktopJs = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

test('H5 exposes a smart plug timer shortcut and loads plug state on schedule view', () => {
  assert.match(h5Html, /id="plugScheduleButton"/);
  assert.match(h5Js, /switchView\("schedule", MIJIA_PLUG_DEVICE_ID\)/);
  assert.match(h5Js, /api\("\/api\/plug"[\s\S]*renderScheduleTargets\(\)/);
});

test('desktop shortcut selects the smart plug before showing schedules', () => {
  assert.match(desktopHtml, /id="desktopPlugSchedule"/);
  assert.match(desktopJs, /#scheduleRoom"\)\.value = MIJIA_PLUG_DEVICE_ID/);
  assert.match(desktopJs, /#scheduleAction"\)\.value = state\.plug\?\.on \? "off" : "on"/);
});
