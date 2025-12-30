#!/usr/bin/env node
/**
 * OpenSystem Asset Sync
 * Downloads assets from S3 based on manifest
 *
 * Usage:
 *   node scripts/sync-assets.js          # Sync all assets
 *   node scripts/sync-assets.js --check  # Dry run, show what would change
 *   node scripts/sync-assets.js --force  # Re-download all files
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const MANIFEST_PATH = process.env.MANIFEST_PATH || './design-system/assets/assets-manifest.json';
const OUTPUT_DIR = process.env.ASSETS_OUTPUT_DIR || './design-system/assets';

// Parse CLI args
const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check') || args.includes('-c');
const FORCE = args.includes('--force') || args.includes('-f');
const VERBOSE = args.includes('--verbose') || args.includes('-v');

function log(msg) {
    console.log(msg);
}

function verbose(msg) {
    if (VERBOSE) console.log(msg);
}

function calculateHash(buffer) {
    return 'sha256:' + crypto.createHash('sha256').update(buffer).digest('hex');
}

function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;

        // Ensure directory exists
        const dir = path.dirname(destPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const file = fs.createWriteStream(destPath);

        protocol.get(url, (response) => {
            if (response.statusCode === 301 || response.statusCode === 302) {
                // Follow redirect
                downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
                return;
            }

            if (response.statusCode !== 200) {
                reject(new Error(`HTTP ${response.statusCode}`));
                return;
            }

            response.pipe(file);

            file.on('finish', () => {
                file.close();
                resolve();
            });
        }).on('error', (err) => {
            fs.unlink(destPath, () => {}); // Delete partial file
            reject(err);
        });
    });
}

async function sync() {
    // Check manifest exists
    if (!fs.existsSync(MANIFEST_PATH)) {
        console.error(`Manifest not found: ${MANIFEST_PATH}`);
        console.error('Run "git pull" to fetch the latest manifest.');
        process.exit(1);
    }

    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    const assets = manifest.assets || {};
    const assetCount = Object.keys(assets).length;

    log(`OpenSystem Asset Sync v${manifest.version || '1.0.0'}`);
    log(`Project: ${manifest.project?.name || 'Unknown'}`);
    log(`Found ${assetCount} assets in manifest\n`);

    if (assetCount === 0) {
        log('No assets to sync.');
        return;
    }

    let downloaded = 0;
    let skipped = 0;
    let errors = 0;

    for (const [key, asset] of Object.entries(assets)) {
        const localPath = path.join(OUTPUT_DIR, asset.localPath.replace(/^assets\//, ''));

        // Check if file exists and hash matches
        if (!FORCE && fs.existsSync(localPath)) {
            const existing = fs.readFileSync(localPath);
            const existingHash = calculateHash(existing);

            if (existingHash === asset.hash) {
                verbose(`✓ ${key} (cached)`);
                skipped++;
                continue;
            }
        }

        if (CHECK_ONLY) {
            log(`↓ Would download: ${key}`);
            downloaded++;
            continue;
        }

        try {
            await downloadFile(asset.url, localPath);
            log(`↓ ${key}`);
            downloaded++;
        } catch (err) {
            console.error(`✗ ${key}: ${err.message}`);
            errors++;
        }
    }

    log(`\n${CHECK_ONLY ? 'Would sync' : 'Synced'}: ${downloaded} downloaded, ${skipped} cached, ${errors} errors`);

    if (errors > 0) {
        process.exit(1);
    }
}

sync().catch((err) => {
    console.error('Sync failed:', err.message);
    process.exit(1);
});
