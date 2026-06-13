// goodloka-inspect-all-games.js – Extrait les conditions de toutes les parties disponibles sur la page domino
const { connect } = require('puppeteer-real-browser');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const phone    = process.env.PHONE;
const password = process.env.PASSWORD;

if (!phone || !password) {
    console.error('❌ PHONE et PASSWORD sont obligatoires');
    process.exit(1);
}

const screenshotsDir = path.join(__dirname, 'screenshots');
const videosDir = path.join(__dirname, 'videos');
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min, max) => delay(Math.floor(Math.random() * (max - min + 1) + min));

async function fillFieldHuman(page, selector, value, fieldName) {
    console.log(`⌨️ Remplissage de ${fieldName}...`);
    let attempts = 0;
    const maxAttempts = 3;
    while (attempts < maxAttempts) {
        try {
            await page.waitForSelector(selector, { visible: true, timeout: 10000 });
            break;
        } catch (e) {
            attempts++;
            if (attempts >= maxAttempts) throw new Error(`Impossible de trouver le champ ${fieldName}`);
            console.log(`⚠️ Champ ${fieldName} pas encore visible, tentative ${attempts}/${maxAttempts}`);
        }
    }
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await randomDelay(100, 200);
    for (const char of value) {
        await page.keyboard.type(char, { delay: Math.floor(Math.random() * 70) + 30 });
    }
    await randomDelay(200, 500);
    let actual = await page.$eval(selector, el => el.value);
    if (actual !== value) {
        console.warn(`⚠️ Correction du champ ${fieldName}`);
        await page.click(selector, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        for (const char of value) await page.keyboard.type(char, { delay: Math.floor(Math.random() * 50) + 40 });
    }
}

async function humanClickAt(page, coords) {
    const start = await page.evaluate(() => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 }));
    const steps = 20;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const cp = { x: start.x + (Math.random() - 0.5) * 100, y: start.y + (Math.random() - 0.5) * 100 };
        const x = Math.pow(1 - t, 2) * start.x + 2 * (1 - t) * t * cp.x + Math.pow(t, 2) * coords.x;
        const y = Math.pow(1 - t, 2) * start.y + 2 * (1 - t) * t * cp.y + Math.pow(t, 2) * coords.y;
        await page.mouse.move(x, y);
        await delay(15);
    }
    await page.mouse.click(coords.x, coords.y);
    console.log(`🖱️ Clic à (${coords.x}, ${coords.y})`);
}

function startFFmpeg(videoPath) {
    const display = process.env.DISPLAY || ':99';
    const args = ['-f','x11grab','-video_size','1280x720','-i',display,'-c:v','libx264','-preset','ultrafast','-crf','0','-pix_fmt','yuv420p','-y',videoPath];
    const ffmpeg = spawn('ffmpeg', args, { stdio: 'inherit' });
    console.log(`🎥 FFmpeg démarré sur ${display} → ${videoPath}`);
    return ffmpeg;
}
function stopFFmpeg(ffmpeg) {
    return new Promise((resolve) => { ffmpeg.on('close', resolve); ffmpeg.kill('SIGINT'); });
}

// --- Extraction des conditions de toutes les parties ---
async function extractAllGamesConditions(page) {
    return await page.evaluate(() => {
        const games = [];
        // Trouver tous les boutons "Rejoindre"
        const btns = [...document.querySelectorAll('button')];
        const joinBtns = btns.filter(b => b.textContent.trim() === 'Rejoindre');

        joinBtns.forEach((btn, index) => {
            // Remonter au conteneur de la carte de jeu (plusieurs niveaux possibles)
            let container = btn.closest('.game-card, .match-item, .room-item, .table-row, li, div[class*="game"], div[class*="match"], div[class*="room"]');
            if (!container) {
                container = btn.parentElement?.parentElement?.parentElement;
            }
            if (container) {
                const text = container.textContent.replace(/\s+/g, ' ').trim();
                games.push({
                    index,
                    text
                });
            }
        });

        // Si aucun conteneur trouvé, on prend le parent immédiat du bouton
        if (games.length === 0) {
            joinBtns.forEach((btn, i) => {
                const parent = btn.parentElement;
                if (parent) {
                    games.push({
                        index: i,
                        text: parent.textContent.replace(/\s+/g, ' ').trim()
                    });
                }
            });
        }

        return games;
    });
}

(async () => {
    const videoPath = path.join(videosDir, `goodloka_all_games_${phone.replace(/[^a-zA-Z0-9]/g, '_')}.mp4`);
    let ffmpegProcess, browser;
    try {
        const { browser: br, page } = await connect({
            headless: false,
            turnstile: false,
            args: [
                '--no-sandbox',
                '--disable-save-password-bubble',
                '--disable-features=PasswordManager'
            ]
        });
        browser = br;
        await page.setViewport({ width: 1280, height: 720 });

        ffmpegProcess = startFFmpeg(videoPath);
        await delay(1000);

        // 1. Login
        const loginUrl = 'https://www.goodloka.com/auth/login';
        console.log(`🌐 Navigation vers ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(5000);

        await fillFieldHuman(page, 'input[type="text"][placeholder*="Ex"]', phone, 'téléphone');
        await fillFieldHuman(page, 'input[type="password"]', password, 'mot de passe');
        await randomDelay(500, 1500);

        console.log('⏎ Appui sur Entrée pour valider la connexion...');
        await page.keyboard.press('Enter');

        console.log('⏳ Attente de la redirection...');
        try {
            await page.waitForFunction(() => !window.location.href.includes('login'), { timeout: 30000 });
        } catch (e) { console.warn('⚠️ Redirection non détectée'); }
        await delay(5000);
        console.log(`📍 URL après connexion : ${page.url()}`);

        // 2. Aller sur la liste des jeux
        const gamesListUrl = 'https://www.goodloka.com/games/list';
        console.log(`🎮 Navigation vers ${gamesListUrl}`);
        await page.goto(gamesListUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(5000);

        // 3. Cliquer sur le premier lien "Jouer" (domino)
        console.log('⏳ Attente du premier lien "Jouer"...');
        let jouerClicked = false;
        try {
            await page.waitForSelector('a', { visible: true, timeout: 15000 });
            const jouerHandle = await page.evaluateHandle(() => {
                const links = [...document.querySelectorAll('a')];
                return links.find(a => a.textContent.trim() === 'Jouer' && a.offsetParent !== null);
            });
            if (jouerHandle) {
                const box = await jouerHandle.boundingBox();
                if (box) {
                    await humanClickAt(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
                    jouerClicked = true;
                } else {
                    await jouerHandle.evaluate(el => el.click());
                    jouerClicked = true;
                }
                await jouerHandle.dispose();
            } else {
                const clicked = await page.evaluate(() => {
                    const links = [...document.querySelectorAll('a')];
                    const jouer = links.find(a => a.textContent.trim() === 'Jouer');
                    if (jouer) { jouer.click(); return true; }
                    return false;
                });
                jouerClicked = clicked;
            }
        } catch (err) {
            console.warn('⚠️ Erreur lors du clic sur "Jouer" :', err.message);
        }
        if (!jouerClicked) {
            console.log('⚠️ Impossible de cliquer sur "Jouer". On continue quand même avec l\'URL actuelle.');
        }
        await delay(5000);
        console.log(`📍 URL après tentative de clic : ${page.url()}`);

        // 4. Capturer la page complète
        await page.screenshot({ path: path.join(screenshotsDir, 'domino_all_games.png'), fullPage: true });

        // 5. Extraire les conditions de chaque partie disponible
        const games = await extractAllGamesConditions(page);
        if (games.length === 0) {
            console.log('⚠️ Aucune partie disponible (aucun bouton "Rejoindre" trouvé).');
        } else {
            console.log(`📋 ${games.length} partie(s) trouvée(s) :`);
            games.forEach((game, i) => {
                console.log(`\n--- Partie #${i + 1} ---`);
                console.log(game.text);
            });
        }

        // 6. Tenter d'ouvrir une fenêtre de détails en cliquant sur le bouton "info-btn" (si présent)
        const infoBtn = await page.$('button.info-btn');
        if (infoBtn) {
            console.log('🖱️ Clic sur le bouton info pour voir les détails supplémentaires...');
            await infoBtn.click();
            await delay(3000);
            await page.screenshot({ path: path.join(screenshotsDir, 'info_modal.png'), fullPage: true });
            const modalTexts = await page.$$eval('*', els =>
                els.filter(el => el.offsetParent !== null && el.textContent.trim().length > 0 && el.children.length === 0)
                    .map(el => el.textContent.trim().substring(0, 100))
                    .slice(0, 20)
            );
            console.log('📝 Textes dans la modale info :');
            modalTexts.forEach((t, i) => console.log(`  ${i+1}. "${t}"`));
        } else {
            console.log('ℹ️ Aucun bouton info-btn trouvé pour afficher plus de détails.');
        }

        await stopFFmpeg(ffmpegProcess);
        await browser.close();

        console.log('🎉 Inspection terminée avec succès.');
        process.exit(0);
    } catch (err) {
        console.error('❌ Erreur fatale :', err.message);
        if (ffmpegProcess) await stopFFmpeg(ffmpegProcess);
        if (browser) await browser.close();
        process.exit(1);
    }
})();
