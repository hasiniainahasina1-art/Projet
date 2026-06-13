// goodloka-join-game.js – Rejoint une partie selon critères (sans vidéo)
const { connect } = require('puppeteer-real-browser');
const { Octokit } = require('@octokit/rest');
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
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

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

// --- Extraction des parties ---
async function extractGamesWithButtons(page) {
    return await page.evaluate(() => {
        const games = [];
        const allButtons = [...document.querySelectorAll('button')];
        const joinBtns = allButtons.filter(b => b.textContent.trim() === 'Rejoindre');

        joinBtns.forEach((btn, index) => {
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
            games.push({ index, text });
        });
        return games;
    });
}

// --- Parsing d'une carte de partie ---
function parseGameText(text) {
    const info = { score: null, mise: null, condition: null, creator: null };
    const scoreMatch = text.match(/Classique\s+(\d+)/);
    if (scoreMatch) info.score = parseInt(scoreMatch[1]);
    const miseMatch = text.match(/(\d[\d\s]*)\s*MGA/);
    if (miseMatch) info.mise = parseInt(miseMatch[1].replace(/\s/g, ''));
    const condMatch = text.match(/[<>]\s*\d+/);
    if (condMatch) info.condition = condMatch[0].replace(/\s/g, '');
    const afterScore = text.replace(/.*?Classique\s+\d+\s*/, '');
    const beforeMise = afterScore.split(/\d[\d\s]*MGA/)[0];
    info.creator = beforeMise.trim().split(',')[0].trim();
    return info;
}

function matchesCriteria(gameInfo, sScore, sMise, sCond) {
    if (sScore !== null && gameInfo.score !== sScore) return false;
    if (sMise !== null && gameInfo.mise !== sMise) return false;
    if (sCond && gameInfo.condition !== sCond) return false;
    return true;
}

(async () => {
    let browser;
    try {
        const { browser: br, page } = await connect({
            headless: false,
            turnstile: false,
            args: ['--no-sandbox', '--disable-save-password-bubble', '--disable-features=PasswordManager']
        });
        browser = br;
        await page.setViewport({ width: 1280, height: 720 });

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
        try { await page.waitForFunction(() => !window.location.href.includes('login'), { timeout: 30000 }); } catch (e) {}
        await delay(5000);
        console.log(`📍 URL après connexion : ${page.url()}`);

        // 2. Aller sur la liste des jeux et cliquer sur "Jouer"
        const gamesListUrl = 'https://www.goodloka.com/games/list';
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
        }
        await delay(5000);
        console.log(`📍 Page domino : ${page.url()}`);

        // 3. Attendre les boutons Rejoindre
        try { await page.waitForSelector('button:has-text("Rejoindre")', { visible: true, timeout: 30000 }); } catch (e) {
            await page.reload({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
            await delay(5000);
        }

        // 4. Boucle de recherche (max 5 minutes)
        const MAX_WAIT_MS = 5 * 60 * 1000;
        const RELOAD_INTERVAL = 30000;
        const startWait = Date.now();
        let lastReload = 0;
        let foundIndex = -1;

        console.log('⏳ Recherche de la partie idéale...');
        while (Date.now() - startWait < MAX_WAIT_MS) {
            const games = await extractGamesWithButtons(page);
            console.log(`🔎 ${games.length} partie(s) visible(s)`);

            let bestMatch = null;
            for (const game of games) {
                const info = parseGameText(game.text);
                console.log(`   Partie #${game.index+1} : score=${info.score}, mise=${info.mise}, condition=${info.condition ?? 'aucune'}, créateur="${info.creator}"`);
                if (matchesCriteria(info, searchScore, searchMise, searchCondition)) {
                    bestMatch = game;
                    break;
                }
            }

            if (bestMatch) {
                console.log(`✅ Partie correspondante trouvée (Index ${bestMatch.index})`);
                const btns = await page.$$('button');
                const joinBtns = [];
                for (const btn of btns) {
                    const txt = await page.evaluate(el => el.textContent.trim(), btn);
                    if (txt === 'Rejoindre') joinBtns.push(btn);
                }
                if (bestMatch.index < joinBtns.length) {
                    await joinBtns[bestMatch.index].click();
                    console.log('🖱️ Clic sur Rejoindre');
                    foundIndex = bestMatch.index;
                    break;
                }
            }

            if (Date.now() - lastReload >= RELOAD_INTERVAL) {
                console.log('🔄 Rafraîchissement...');
                await page.reload({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
                lastReload = Date.now();
                await delay(5000);
                try { await page.waitForSelector('button:has-text("Rejoindre")', { visible: true, timeout: 15000 }); } catch (e) {}
            } else {
                await delay(10000);
            }
        }

        if (foundIndex >= 0) {
            await delay(3000);
            console.log(`📍 URL après clic : ${page.url()}`);
            await page.screenshot({ path: path.join(screenshotsDir, 'joined_game.png'), fullPage: true });
            console.log('🎉 Partie rejointe !');
        } else {
            await page.screenshot({ path: path.join(screenshotsDir, 'no_match.png'), fullPage: true });
            console.log('⚠️ Aucune partie trouvée après 5 minutes.');
        }

        await browser.close();
        process.exit(0);
    } catch (err) {
        console.error('❌ Erreur fatale :', err.message);
        if (browser) await browser.close();
        process.exit(1);
    }
})();
