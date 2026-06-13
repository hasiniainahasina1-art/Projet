// goodloka-create-and-wait.js – Créer une partie, attendre un adversaire, inspecter ses dominos (corrigé)
const { connect } = require('puppeteer-real-browser');
const path = require('path');
const fs = require('fs');

const phone    = process.env.PHONE;
const password = process.env.PASSWORD;
const desiredScore = process.env.SCORE || '50';
const desiredMise  = process.env.MISE || '200';
const desiredJoueurs = process.env.JOUEURS || '2';
const waitTimeout = 5 * 60 * 1000; // 5 minutes

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

// --- Vérifier la présence d'un bouton de jeu (Jouer, Piocher, Passer) ---
async function hasGameButton(page) {
    return await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('button')];
        return buttons.some(b => {
            const t = b.textContent.trim().toLowerCase();
            return t.includes('jouer') || t.includes('piocher') || t.includes('passer');
        });
    });
}

// --- Inspection des dominos adverses ---
async function inspectDominoes(page) {
    console.log('🔍 Inspection des dominos adverses...');
    await delay(3000);
    await page.screenshot({ path: path.join(screenshotsDir, 'game_board.png'), fullPage: true });

    const dominoElements = await page.$$eval('*', els =>
        els
            .filter(el => {
                const text = el.textContent.trim();
                // Détecter les dominos Unicode (plage 1F030-1F09F)
                for (const ch of text) {
                    const cp = ch.codePointAt(0);
                    if (cp >= 0x1F030 && cp <= 0x1F09F) return true;
                }
                // Détecter les motifs "4:2"
                return /\d+:\d+/.test(text);
            })
            .map(el => ({
                tag: el.tagName,
                class: el.className,
                id: el.id,
                text: el.textContent.trim().substring(0, 30),
                rect: el.getBoundingClientRect()
            }))
    );

    console.log(`🎲 ${dominoElements.length} dominos détectés :`);
    dominoElements.forEach((d, i) => {
        console.log(`   ${i+1}. <${d.tag}> class="${d.class}" text="${d.text}" pos=(${Math.round(d.rect.x)},${Math.round(d.rect.y)})`);
    });
    return dominoElements;
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

        // 3. Cliquer sur "Créer une partie"
        const createBtn = await findButtonByText(page, 'Créer une partie');
        if (!createBtn) throw new Error('Bouton "Créer une partie" introuvable');
        await createBtn.click();
        console.log('✅ Modale de création ouverte');
        await delay(3000);

        // 4. Sélectionner les options

        // Mode Classique
        const modeBtns = await page.$$('button.mode-pill');
        if (modeBtns.length >= 1) {
            let classiqueBtn = null;
            for (const b of modeBtns) {
                const txt = await page.evaluate(el => el.textContent.trim(), b);
                if (txt.includes('Classique')) {
                    classiqueBtn = b;
                    break;
                }
            }
            if (classiqueBtn) await classiqueBtn.click();
            else await modeBtns[0].click();
            console.log('✅ Mode Classique sélectionné');
        }
        await delay(1000);

        // Score
        const scoreBtn = await findButtonByText(page, desiredScore);
        if (scoreBtn) {
            await scoreBtn.click();
            console.log(`✅ Score ${desiredScore} sélectionné`);
        }
        await delay(500);

        // Mise
        const miseBtn = await findButtonByText(page, desiredMise);
        if (miseBtn) {
            await miseBtn.click();
            console.log(`✅ Mise ${desiredMise} sélectionnée`);
        }
        await delay(500);

        // Nombre de joueurs
        const joueursBtn = await findButtonByText(page, `${desiredJoueurs} joueurs`);
        if (joueursBtn) {
            await joueursBtn.click();
            console.log(`✅ ${desiredJoueurs} joueurs sélectionné`);
        }
        await delay(500);

        // Désactiver les conditions
        const allButtons = await page.$$('button');
        for (const btn of allButtons) {
            const txt = await page.evaluate(el => el.textContent.trim(), btn);
            const cls = await page.evaluate(el => el.className, btn);
            if ((txt.match(/[<>]\s*\d/) || txt.includes('📅')) && (cls.includes('active') || cls.includes('selected'))) {
                await btn.click();
                console.log(`🔓 Condition "${txt}" désactivée`);
                await delay(300);
            }
        }
        console.log('✅ Conditions désactivées');

        // 5. Créer la partie
        const createFinalBtn = await findButtonByText(page, 'Créer la partie');
        if (createFinalBtn) {
            await createFinalBtn.click();
            console.log('🖱️ Partie créée');
        } else {
            throw new Error('Bouton "Créer la partie" introuvable');
        }
        await delay(3000);

        // 6. Attendre un adversaire (max 5 minutes)
        console.log('⏳ Attente d\'un adversaire (max 5 min)...');
        const startWait = Date.now();
        let gameStarted = false;
        while (Date.now() - startWait < waitTimeout) {
            const boardEl = await page.$('.game-board, .board, .domino-table, [class*="board"], [class*="table"]');
            const playBtnVisible = await hasGameButton(page);
            if (boardEl || playBtnVisible) {
                console.log('🎮 Partie commencée !');
                gameStarted = true;
                break;
            }
            const opponentEl = await page.$('.opponent, .player-avatar, [class*="opponent"]');
            if (opponentEl) console.log('👥 Adversaire détecté, attente du démarrage...');
            console.log('⏳ Pas encore de partie...');
            await delay(10000);
        }

        if (gameStarted) {
            await inspectDominoes(page);
        } else {
            console.log('⚠️ Aucun adversaire après 5 minutes.');
            await page.screenshot({ path: path.join(screenshotsDir, 'no_opponent.png'), fullPage: true });
        }

        await browser.close();
        process.exit(0);
    } catch (err) {
        console.error('❌ Erreur fatale :', err.message);
        if (browser) await browser.close();
        process.exit(1);
    }
})();
