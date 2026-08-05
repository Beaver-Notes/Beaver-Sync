'use strict';

const Handlebars = require('handlebars');
const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, 'templates');
const LOGO_PATH = path.join(__dirname, 'assets', 'logo.png');

const compiledCache = new Map();
let baseRegistered = false;

function getLogoDataUri() {
  const buf = fs.readFileSync(LOGO_PATH);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

function ensureBaseRegistered() {
  if (baseRegistered) return;
  const src = fs.readFileSync(path.join(TEMPLATES_DIR, 'base.hbs'), 'utf8');
  const compiled = Handlebars.compile(src);
  Handlebars.registerPartial('base', compiled);
  baseRegistered = true;
}

function render(templateName, data) {
  ensureBaseRegistered();
  try {
    const templatePath = path.join(TEMPLATES_DIR, `${templateName}.hbs`);
    if (!fs.existsSync(templatePath)) return null;

    let compiled = compiledCache.get(templateName);
    if (!compiled) {
      const src = fs.readFileSync(templatePath, 'utf8');
      compiled = Handlebars.compile(src);
      compiledCache.set(templateName, compiled);
    }

    return compiled(data);
  } catch (err) {
    console.error(`[email] Failed to render template "${templateName}":`, err.message);
    return null;
  }
}

module.exports = { render, getLogoDataUri };
