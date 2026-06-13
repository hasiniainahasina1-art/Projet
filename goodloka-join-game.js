// goodloka-join-game.js – Recherche et rejoint une partie selon critères
const { connect } = require('puppeteer-real-browser');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const phone    = process.env.PHONE;
const password = process.env.PASSWORD;
const searchScore     = process.env.SCORE ? parseInt(process.env.SCORE) : null;
const searchMise      = process.env.MISE ? parseInt(process.env.MISE) : null;
const searchCondition = process.env.CONDITION || null;

if (!phone || !password) {
    console.error('❌ PHONE et PASSWORD sont obligatoires');
    process.exit(1);
}

console.log('🔍 Critères de recherche :');
console.log(`   Score     : ${searchScore ?? 'peu importe'}`);
console.log(`   Mise      : ${searchMise ?? 'peu importe'}`);
console.log(`   Condition : ${searchCondition || 'peu importe'}`);

const screenshotsDir = path.join(__dirname, 'screenshots');
const videosDir = path.join(__dirname, 'videos');
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });
if (!fs.existsSync(videosDir)) fs.mkdirSync(videosDir, { recursive: true });

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min, max) => delay(Math.floor(Math.random() * (max - min + 1) + min));

// --- Fonctions d'interaction humaine ---
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

// --- Extraction structurée des parties ---
async function extractGamesWithButtons(page) {
    return await page.evaluate(() => {
        const games = [];
        const allButtons = [...document.querySelectorAll('button')];
        const joinBtns = allButtons.filter(b => b.textContent.trim() === 'Rejoindre');

        joinBtns.forEach((btn, index) => {
            // Remonter au conteneur de la carte (le plus haut qui ne contient qu'un seul Rejoindre)
            let container = btn;
            while (container) {
                const parent = container.parentElement;
                if (!parent) break;
                const joinCount = [...parent.querySelectorAll('button')]
                    .filter(b => b.textContent.trim() === 'Rejoindre').length;
                if (joinCount === 1) {
                    container = parent;
                } else {
                    break;
                }
            }
            const text = container.textContent.replace(/\s+/g, ' ').trim();
            games.push({
                index,
                text,
                btnXPath: null // on utilisera l'index pour retrouver le bouton plus tard
            });
        });
        return games;
    });
}

// --- Parsing d'une carte de partie ---
function parseGameText(text) {
    // Exemple : "🁣 Classique 50 Lazare🇲🇬 200 MGA < 6 📅 Rejoindre Solde insuffisant ..."
    const info = {
        score: null,
        mise: null,
        condition: null,
        creator: null
    };

    // Extraire le score (nombre après "Classique")
    const scoreMatch = text.match(/Classique\s+(\d+)/);
    if (scoreMatch) info.score = parseInt(scoreMatch[1]);

    // Extraire la mise (nombre avant "MGA")
    const miseMatch = text.match(/(\d[\d\s]*)\s*MGA/);
    if (miseMatch) {
        // Enlever les espaces dans le nombre
        info.mise = parseInt(miseMatch[1].replace(/\s/g, ''));
    }

    // Extraire la condition (< 6, > 10, etc.)
    const condMatch = text.match(/[<>]\s*\d+/);
    if (condMatch) info.condition = condMatch[0].replace(/\s/g, '');

    // Extraire le créateur (texte après le score et avant la mise)
    // Approximatif : entre le score et le premier nombre suivi de MGA
    const afterScore = text.replace(/.*?Classique\s+\d+\s*/, '');
    const beforeMise = afterScore.split(/\d[\d\s]*MGA/)[0];
    info.creator = beforeMise.trim();

    return info;
}

// --- Vérifie si une partie correspond aux critères ---
function matchesCriteria(gameInfo, searchScore, searchMise, searchCondition) {
    if (searchScore !== null && gameInfo.score !== searchScore) return false;
    if (searchMise !== null && gameInfo.mise !== searchMise) return false;
    if (searchCondition && gameInfo.condition !== searchCondition) return false;
    return true;
}

(async () => {
    const videoPath = path.join(videosDir, `goodloka_join_${phone.replace(/[^a-zA-Z0-9]/g, '_')}.mp4`);
    let ffmpegProcess, browser;
    try {
        const { browser: br, page } = await connect({
            headless: false,
            turnstile: false,
            args: ['--no-sandbox', '--disable-save-password-bubble', '--disable-features=PasswordManager']
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

        // 2. Aller sur la liste des jeux et cliquer sur le premier "Jouer" (domino)
        const gamesListUrl = 'https://www.goodloka.com/games/list';
        console.log(`🎮 Navigation vers ${gamesListUrl}`);
        await page.goto(gamesListUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(5000);

        console.log('🔍 Clic sur le premier "Jouer"...');
        const jouerHandle = await page.evaluateHandle(() => {
            const links = [...document.querySelectorAll('a')];
            return links.find(a => a.textContent.trim() === 'Jouer' && a.offsetParent !== null);
        });
        if (jouerHandle) {
            const box = await jouerHandle.boundingBox();
            if (box) await humanClickAt(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
            else await jouerHandle.evaluate(el => el.click());
            await jouerHandle.dispose();
        } else {
            console.log('⚠️ Aucun lien "Jouer" visible.');
        }
        await delay(5000);
        console.log(`📍 Page domino : ${page.url()}`);

        // 3. Boucle de recherche (max 5 minutes)
        const MAX_WAIT_MS = 5 * 60 * 1000;
        const RELOAD_INTERVAL = 30000;
        const startWait = Date.now();
        let lastReload = 0;
        let found = false;

        console.log('⏳ Recherche d\'une partie correspondante (max 5 min)...');
        while (Date.now() - startWait < MAX_WAIT_MS) {
            const games = await extractGamesWithButtons(page);
            if (games.length > 0) {
                for (const game of games) {
                    const info = parseGameText(game.text);
                    console.log(`🔎 Partie #${game.index+1} : score=${info.score}, mise=${info.mise}, condition=${info.condition}, créateur="${info.creator}"`);
                    if (matchesCriteria(info, searchScore, searchMise, searchCondition)) {
                        console.log(`✅ Partie trouvée ! (Index ${game.index})`);
                        // Cliquer sur le bouton Rejoindre correspondant
                        const btns = await page.$$('button');
                        const joinBtns = [];
                        for (const btn of btns) {
                            const text = await page.evaluate(el => el.textContent.trim(), btn);
                            if (text === 'Rejoindre') joinBtns.push(btn);
                        }
                        if (game.index < joinBtns.length) {
                            const targetBtn = joinBtns[game.index];
                            await targetBtn.click();
                            console.log('🖱️ Clic sur le bouton Rejoindre');
                            found = true;
                            break;
                        }
                    }
                }
                if (found) break;
            }

            // Rafraîchir périodiquement
            if (Date.now() - lastReload >= RELOAD_INTERVAL) {
                console.log('🔄 Rafraîchissement de la page...');
                await page.reload({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
                lastReload = Date.now();
                await delay(5000);
            } else {
                console.log('⏳ Aucune correspondance, attente 10s...');
                await delay(10000);
            }
        }

        if (found) {
            await delay(3000);
            await page.screenshot({ path: path.join(screenshotsDir, 'joined_game.png'), fullPage: true });
            console.log('🎉 Partie rejointe avec succès !');
        } else {
            await page.screenshot({ path: path.join(screenshotsDir, 'no_match.png'), fullPage: true });
            console.log('⚠️ Aucune partie correspondante trouvée après 5 minutes.');
        }

        await stopFFmpeg(ffmpegProcess);
        await browser.close();
        console.log('🏁 Script terminé.');
        process.exit(0);
    } catch (err) {
        console.error('❌ Erreur fatale :', err.message);
        if (ffmpegProcess) await stopFFmpeg(ffmpegProcess);
        if (browser) await browser.close();
        process.exit(1);
    }
})();
