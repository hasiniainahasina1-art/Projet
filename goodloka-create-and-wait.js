// goodloka-create-and-wait.js – version avec extraction du plateau et de la main
const { connect } = require('puppeteer-real-browser');
const path = require('path');
const fs = require('fs');

const phone    = process.env.PHONE;
const password = process.env.PASSWORD;
const desiredScore = process.env.SCORE || '50';
const desiredMise  = process.env.MISE || '200';
const desiredJoueurs = process.env.JOUEURS || '2';
const waitTimeout = 5 * 60 * 1000;

if (!phone || !password) {
    console.error('❌ PHONE et PASSWORD sont obligatoires');
    process.exit(1);
}

console.log(`🎮 Configuration : Classique, score=${desiredScore}, mise=${desiredMise}, joueurs=${desiredJoueurs}`);

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

// --- Trouver un bouton par son texte exact ---
async function findButtonByText(page, text) {
    const btns = await page.$$('button');
    for (const btn of btns) {
        const txt = await page.evaluate(el => el.textContent.trim(), btn);
        if (txt === text) return btn;
    }
    return null;
}

async function hasGameButton(page) {
    return await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button')];
        return buttons.some(b => {
            const t = b.textContent.trim().toLowerCase();
            return t.includes('jouer') || t.includes('piocher') || t.includes('passer');
        });
    });
}

// --- Extraire les valeurs d'un domino à partir de ses demi-parties ---
function getDominoValue(domEl) {
    const left = domEl.querySelector('.domino_left');
    const right = domEl.querySelector('.domino_right');
    const lv = left ? (left.dataset?.value || left.getAttribute('data-value') || left.textContent.trim()) : '?';
    const rv = right ? (right.dataset?.value || right.getAttribute('data-value') || right.textContent.trim()) : '?';
    return `${lv}:${rv}`;
}

// --- Analyse complète de l'état du jeu ---
async function analyzeGameState(page) {
    console.log('🔍 Analyse de l\'état du jeu...');
    await delay(3000);
    await page.screenshot({ path: path.join(screenshotsDir, 'game_state.png'), fullPage: true });

    // Dominos sur le plateau
    const boardDominoes = await page.$$eval('.domino_board .domino', els =>
        els.map(el => ({
            value: getDominoValue(el),
            pos: el.getBoundingClientRect()
        }))
    );
    console.log(`🎲 Plateau : ${boardDominoes.length} dominos`);
    boardDominoes.forEach(d => console.log(`   ${d.value} (x=${Math.round(d.pos.x)}, y=${Math.round(d.pos.y)})`));

    // Votre main (dominos cliquables)
    const handDominoes = await page.$$eval('.mx_2.domino.cursor_pointer', els =>
        els.map(el => ({
            value: getDominoValue(el),
            index: el.getAttribute('data-index')
        }))
    );
    console.log(`🖐️ Votre main : ${handDominoes.length} dominos`);
    handDominoes.forEach(d => console.log(`   ${d.value} (index ${d.index})`));

    return { boardDominoes, handDominoes };
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

        console.log('⏎ Appui sur Entrée...');
        await page.keyboard.press('Enter');

        try { await page.waitForFunction(() => !window.location.href.includes('login'), { timeout: 30000 }); } catch (e) {}
        await delay(5000);
        console.log(`📍 Connecté : ${page.url()}`);

        // 2. Domino
        const gamesListUrl = 'https://www.goodloka.com/games/list';
        await page.goto(gamesListUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(5000);

        console.log('🔍 Clic sur "Jouer"...');
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

        // 3. Créer une partie
        const createBtn = await findButtonByText(page, 'Créer une partie');
        if (!createBtn) throw new Error('Bouton introuvable');
        await createBtn.click();
        console.log('✅ Modale création ouverte');
        await delay(3000);

        // Mode Classique
        const modeBtns = await page.$$('button.mode-pill');
        if (modeBtns.length >= 1) {
            let classiqueBtn = null;
            for (const b of modeBtns) {
                if ((await page.evaluate(el => el.textContent.trim(), b)).includes('Classique')) {
                    classiqueBtn = b;
                    break;
                }
            }
            if (classiqueBtn) await classiqueBtn.click();
            else await modeBtns[0].click();
            console.log('✅ Mode Classique');
        }
        await delay(1000);

        // Score, Mise, Joueurs
        const scoreBtn = await findButtonByText(page, desiredScore);
        if (scoreBtn) { await scoreBtn.click(); console.log(`✅ Score ${desiredScore}`); }
        await delay(500);
        const miseBtn = await findButtonByText(page, desiredMise);
        if (miseBtn) { await miseBtn.click(); console.log(`✅ Mise ${desiredMise}`); }
        await delay(500);
        const joueursBtn = await findButtonByText(page, `${desiredJoueurs} joueurs`);
        if (joueursBtn) { await joueursBtn.click(); console.log(`✅ ${desiredJoueurs} joueurs`); }
        await delay(500);

        // Conditions off
        const allBtns = await page.$$('button');
        for (const btn of allBtns) {
            const txt = await page.evaluate(el => el.textContent.trim(), btn);
            const cls = await page.evaluate(el => el.className, btn);
            if ((txt.match(/[<>]\s*\d/) || txt.includes('📅')) && (cls.includes('active') || cls.includes('selected'))) {
                await btn.click();
                console.log(`🔓 Condition "${txt}"`);
                await delay(300);
            }
        }
        console.log('✅ Conditions désactivées');

        // Créer
        const createFinal = await findButtonByText(page, 'Créer la partie');
        if (createFinal) await createFinal.click();
        else throw new Error('Bouton final introuvable');
        console.log('🖱️ Partie créée');
        await delay(3000);

        // Attente adversaire
        console.log('⏳ Attente adversaire...');
        const startWait = Date.now();
        let gameStarted = false;
        while (Date.now() - startWait < waitTimeout) {
            if (await hasGameButton(page) || (await page.$('.domino_board'))) {
                gameStarted = true;
                console.log('🎮 Partie commencée !');
                break;
            }
            console.log('⏳...');
            await delay(10000);
        }

        if (gameStarted) {
            await analyzeGameState(page);
        } else {
            console.log('⚠️ Aucun adversaire après 5 min.');
            await page.screenshot({ path: path.join(screenshotsDir, 'no_opponent.png'), fullPage: true });
        }

        await browser.close();
        process.exit(0);
    } catch (err) {
        console.error('❌', err.message);
        if (browser) await browser.close();
        process.exit(1);
    }
})();
