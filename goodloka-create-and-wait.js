// goodloka-create-and-wait.js – Créer une partie classique, attendre un adversaire, inspecter ses dominos
const { connect } = require('puppeteer-real-browser');
const path = require('path');
const fs = require('fs');

const phone    = process.env.PHONE;
const password = process.env.PASSWORD;
const desiredScore = process.env.SCORE || '50';      // score choisi
const desiredMise  = process.env.MISE || '200';      // mise choisie
const desiredJoueurs = process.env.JOUEURS || '2';   // "2" ou "3"
const waitTimeout = 5 * 60 * 1000;                  // 5 minutes max

if (!phone || !password) {
    console.error('❌ PHONE et PASSWORD sont obligatoires');
    process.exit(1);
}

console.log(`🎮 Configuration de la partie : Classique, score=${desiredScore}, mise=${desiredMise}, joueurs=${desiredJoueurs}`);

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

// --- Recherche d'un bouton par son texte exact ---
async function findButtonByText(page, text) {
    const btns = await page.$$('button');
    for (const btn of btns) {
        const txt = await page.evaluate(el => el.textContent.trim(), btn);
        if (txt === text) return btn;
    }
    return null;
}

// --- Attendre qu'un élément contenant un texte spécifique apparaisse ---
async function waitForElementWithText(page, text, timeout = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const elements = await page.$$('*');
        for (const el of elements) {
            const txt = await page.evaluate(e => e.textContent.trim(), el);
            if (txt === text && el.offsetParent !== null) return el;
        }
        await delay(2000);
    }
    return null;
}

// --- Inspection des dominos (après début de partie) ---
async function inspectDominoes(page) {
    console.log('🔍 Inspection des dominos adverses...');
    await delay(3000);
    await page.screenshot({ path: path.join(screenshotsDir, 'game_board.png'), fullPage: true });

    const dominoElements = await page.$$eval('*', els =>
        els
            .filter(el => {
                const text = el.textContent.trim();
                return /[\🁣\🁢\🁤\🁥\🁦\🁧\🁨\🁩\🁪\🁫\🁬\🁭\🁮\🁯\🁰\🁱\🁲\🁳\🁴\🁵\🁶\🁷\🁸\🁹\🁺\🁻\🁼\🁽\🁾\🁿]/u.test(text) || /\d+:\d+/.test(text);
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

        // 2. Aller sur la liste des jeux et cliquer sur "Jouer" (Domino)
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

        // Mode Classique (le premier bouton avec "Classique")
        const modeBtns = await page.$$('button.mode-pill');
        if (modeBtns.length >= 1) {
            // S'assurer que le premier (classique) est actif
            const modeClassique = modeBtns[0];
            const modeText = await page.evaluate(el => el.textContent.trim(), modeClassique);
            if (!modeText.includes('Classique')) {
                // Sinon chercher celui avec "Classique"
                for (const b of modeBtns) {
                    const txt = await page.evaluate(el => el.textContent.trim(), b);
                    if (txt.includes('Classique')) {
                        await b.click();
                        break;
                    }
                }
            } else {
                // Déjà classique, on clique pour être sûr
                await modeClassique.click();
            }
            console.log('✅ Mode Classique sélectionné');
        } else {
            console.warn('⚠️ Boutons de mode non trouvés');
        }
        await delay(1000);

        // Score
        const scoreBtn = await findButtonByText(page, desiredScore);
        if (scoreBtn) {
            await scoreBtn.click();
            console.log(`✅ Score ${desiredScore} sélectionné`);
        } else {
            console.warn(`⚠️ Bouton score ${desiredScore} introuvable`);
        }
        await delay(500);

        // Mise (le bouton avec le texte exact)
        const miseBtn = await findButtonByText(page, desiredMise);
        if (miseBtn) {
            await miseBtn.click();
            console.log(`✅ Mise ${desiredMise} sélectionnée`);
        } else {
            console.warn(`⚠️ Bouton mise ${desiredMise} introuvable`);
        }
        await delay(500);

        // Nombre de joueurs
        const joueursBtn = await findButtonByText(page, `${desiredJoueurs} joueurs`);
        if (joueursBtn) {
            await joueursBtn.click();
            console.log(`✅ ${desiredJoueurs} joueurs sélectionné`);
        } else {
            console.warn(`⚠️ Bouton "${desiredJoueurs} joueurs" introuvable`);
        }
        await delay(500);

        // Décocher toute condition : on parcourt les boutons ayant "condition" dans leur classe ou texte
        // On cherche des éléments comme <button class="cond-pill cond-pill--active"> ou similaires.
        // Pour l'instant, on va cliquer sur chaque bouton qui semble être une condition active (ex: si contient "<" ou "📅")
        // Si aucun bouton condition trouvé, on ignore.
        const allButtons = await page.$$('button');
        for (const btn of allButtons) {
            const txt = await page.evaluate(el => el.textContent.trim(), btn);
            const cls = await page.evaluate(el => el.className, btn);
            if (txt.match(/[<>]\s*\d/) || txt.includes('📅')) {
                // Si le bouton semble actif (class active), on clique pour désactiver
                if (cls.includes('active') || cls.includes('selected')) {
                    await btn.click();
                    console.log(`🔓 Condition "${txt}" désactivée`);
                    await delay(300);
                }
            }
        }
        console.log('✅ Conditions désactivées');

        // 5. Cliquer sur "Créer la partie" (le bouton final)
        const createFinalBtn = await findButtonByText(page, 'Créer la partie');
        if (createFinalBtn) {
            await createFinalBtn.click();
            console.log('🖱️ Partie créée');
        } else {
            throw new Error('Bouton "Créer la partie" introuvable dans la modale');
        }
        await delay(3000);

        // 6. Attendre qu'un adversaire rejoigne (max 5 minutes)
        console.log('⏳ Attente d\'un adversaire (max 5 min)...');
        const startWait = Date.now();
        let gameStarted = false;
        while (Date.now() - startWait < waitTimeout) {
            // Signes de début de partie : présence d'éléments de jeu (plateau, boutons "Jouer", etc.)
            const boardEl = await page.$('.game-board, .board, .domino-table, [class*="board"], [class*="table"]');
            const playBtn = await page.$('button:has-text("Jouer"), button:has-text("Piocher"), button:has-text("Passer")');
            if (boardEl || playBtn) {
                console.log('🎮 Partie commencée !');
                gameStarted = true;
                break;
            }

            // Vérifier aussi la présence d'un élément indiquant l'adversaire (avatar, nom)
            const opponentEl = await page.$('.opponent, .player-avatar, [class*="opponent"]');
            if (opponentEl) {
                console.log('👥 Adversaire détecté, en attente du début de partie...');
                // On continue d'attendre que le jeu démarre
            }

            console.log('⏳ Pas encore de partie...');
            await delay(10000);
        }

        if (gameStarted) {
            // 7. Inspecter les dominos adverses
            await inspectDominoes(page);
        } else {
            console.log('⚠️ Aucun adversaire n\'a rejoint après 5 minutes.');
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
