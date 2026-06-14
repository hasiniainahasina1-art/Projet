// goodloka-bot.js – Bot de jeu de dominos GoodLoka (création + jeu automatique)
const { connect } = require('puppeteer-real-browser');
const path = require('path');
const fs = require('fs');

const phone    = process.env.PHONE;
const password = process.env.PASSWORD;
const desiredScore = process.env.SCORE || '50';
const desiredMise  = process.env.MISE || '200';
const desiredJoueurs = process.env.JOUEURS || '2';
const waitTimeout = 5 * 60 * 1000; // 5 min d'attente max

if (!phone || !password) {
    console.error('❌ PHONE et PASSWORD sont obligatoires');
    process.exit(1);
}

const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Utilitaires d'interaction humaine (pour le login) ---
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
            if (attempts >= maxAttempts) throw new Error(`Champ ${fieldName} introuvable`);
        }
    }
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await delay(100 + Math.random() * 200);
    for (const char of value) {
        await page.keyboard.type(char, { delay: Math.floor(Math.random() * 70) + 30 });
    }
    await delay(200 + Math.random() * 300);
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
}

async function findButtonByText(page, text) {
    const btns = await page.$$('button');
    for (const btn of btns) {
        const txt = await page.evaluate(el => el.textContent.trim(), btn);
        if (txt === text) return btn;
    }
    return null;
}

// --- Lecture du plateau et de la main ---
async function getBoardEnds(page) {
    // Extrémités déduites des dominos posés : on regarde le premier et le dernier dans l'ordre du DOM
    const ends = await page.$$eval('.domino_board .domino', els => {
        if (els.length === 0) return null;
        const getVal = (el, side) => {
            const half = el.querySelector(`.domino_${side}`);
            return half ? (half.dataset?.value || half.getAttribute('data-value') || half.textContent.trim()) : null;
        };
        const first = els[0];
        const last = els[els.length - 1];
        return {
            left: getVal(first, 'left'),   // extrémité gauche = partie gauche du premier domino
            right: getVal(last, 'right')   // extrémité droite = partie droite du dernier domino
        };
    });
    return ends;
}

async function getHandDominoes(page) {
    return await page.$$eval('.mx_2.domino.cursor_pointer', els =>
        els.map(el => {
            const left = el.querySelector('.domino_left');
            const right = el.querySelector('.domino_right');
            const lv = left ? (left.dataset?.value || left.getAttribute('data-value') || left.textContent.trim()) : '?';
            const rv = right ? (right.dataset?.value || right.getAttribute('data-value') || right.textContent.trim()) : '?';
            return {
                element: el,
                value: `${lv}:${rv}`,
                leftVal: lv,
                rightVal: rv,
                index: el.getAttribute('data-index')
            };
        })
    );
}

// --- Choix du meilleur domino à jouer ---
function chooseBestDomino(hand, ends) {
    if (!ends) return hand[0]; // premier domino si on ne peut pas déterminer les extrémités
    const { left, right } = ends;
    // Priorité : domino qui correspond aux deux extrémités (double avec le bon numéro)
    for (const d of hand) {
        if (d.leftVal === left && d.rightVal === right) return d;
        if (d.leftVal === right && d.rightVal === left) return d;
    }
    // Ensuite, domino qui correspond à une extrémité, en privilégiant les doubles
    let best = null;
    for (const d of hand) {
        if (d.leftVal === left || d.rightVal === left || d.leftVal === right || d.rightVal === right) {
            if (!best) best = d;
            else if (d.leftVal === d.rightVal) best = d; // double prioritaire
        }
    }
    return best;
}

// --- Exécution d'un tour : jouer un domino ou piocher ---
async function playTurn(page) {
    const ends = await getBoardEnds(page);
    const hand = await getHandDominoes(page);
    if (hand.length === 0) {
        console.log('🤷 Aucun domino jouable, on tente de piocher...');
        const piocheBtn = await findButtonByText(page, 'Piocher');
        if (piocheBtn) {
            await piocheBtn.click();
            console.log('🃏 Pioche effectuée');
        }
        return;
    }

    const chosen = chooseBestDomino(hand, ends);
    console.log(`🎯 Domino choisi : ${chosen.value} (index ${chosen.index})`);

    // Double‑clic pour sélectionner
    await chosen.element.click();
    await delay(200);
    await chosen.element.click();

    // Essayer de valider le coup : bouton "Jouer" ou Entrée
    const jouerBtn = await findButtonByText(page, 'Jouer');
    if (jouerBtn) {
        await jouerBtn.click();
        console.log('🖱️ Clic sur Jouer');
    } else {
        await page.keyboard.press('Enter');
        console.log('⏎ Entrée pressée');
    }
    await delay(2000);
}

// --- Boucle principale de jeu ---
async function gameLoop(page, maxTurns = 100) {
    for (let turn = 0; turn < maxTurns; turn++) {
        console.log(`\n🔄 Tour ${turn + 1}`);
        await playTurn(page);

        // Vérifier si la partie est terminée (disparition du plateau)
        const board = await page.$('.domino_board');
        if (!board) {
            console.log('🏁 Partie terminée (plateau disparu)');
            break;
        }
        // Petite pause pour ne pas surcharger
        await delay(1000);
    }
}

// --- Main ---
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
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(5000);
        await fillFieldHuman(page, 'input[type="text"][placeholder*="Ex"]', phone, 'téléphone');
        await fillFieldHuman(page, 'input[type="password"]', password, 'mot de passe');
        await page.keyboard.press('Enter');
        await delay(5000);

        // 2. Accès au domino
        const gamesListUrl = 'https://www.goodloka.com/games/list';
        await page.goto(gamesListUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(5000);
        const jouerLink = await page.evaluateHandle(() => {
            const links = [...document.querySelectorAll('a')];
            return links.find(a => a.textContent.trim() === 'Jouer' && a.offsetParent !== null);
        });
        if (jouerLink) {
            const box = await jouerLink.boundingBox();
            if (box) await humanClickAt(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
            else await jouerLink.evaluate(el => el.click());
            await jouerLink.dispose();
        }
        await delay(5000);

        // 3. Création de partie (classique, score=50, mise=200, 2 joueurs, sans condition)
        const createBtn = await findButtonByText(page, 'Créer une partie');
        if (createBtn) await createBtn.click();
        await delay(3000);

        // Mode Classique
        const modeBtns = await page.$$('button.mode-pill');
        for (const b of modeBtns) {
            if ((await page.evaluate(el => el.textContent.trim(), b)).includes('Classique')) {
                await b.click();
                break;
            }
        }
        await delay(1000);
        (await findButtonByText(page, desiredScore))?.click();
        await delay(500);
        (await findButtonByText(page, desiredMise))?.click();
        await delay(500);
        (await findButtonByText(page, `${desiredJoueurs} joueurs`))?.click();
        await delay(500);
        // Désactiver conditions
        const allBtns = await page.$$('button');
        for (const btn of allBtns) {
            const txt = await page.evaluate(el => el.textContent.trim(), btn);
            const cls = await page.evaluate(el => el.className, btn);
            if ((txt.match(/[<>]\s*\d/) || txt.includes('📅')) && (cls.includes('active') || cls.includes('selected'))) {
                await btn.click();
                await delay(300);
            }
        }
        (await findButtonByText(page, 'Créer la partie'))?.click();
        await delay(3000);

        // 4. Attente adversaire
        console.log('⏳ Attente adversaire...');
        const startWait = Date.now();
        while (Date.now() - startWait < waitTimeout) {
            if ((await page.$('.domino_board')) || (await page.$('button:has-text("Jouer")'))) {
                console.log('🎮 Partie commencée !');
                break;
            }
            await delay(10000);
        }

        // 5. Jouer automatiquement
        await gameLoop(page);

        await browser.close();
        process.exit(0);
    } catch (err) {
        console.error('❌', err.message);
        if (browser) await browser.close();
        process.exit(1);
    }
})();
