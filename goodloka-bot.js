// goodloka-bot.js – Bot de jeu de dominos GoodLoka (correction handles DOM)
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

const screenshotsDir = path.join(__dirname, 'screenshots');
if (!fs.existsSync(screenshotsDir)) fs.mkdirSync(screenshotsDir, { recursive: true });

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

// --- Récupération des extrémités du plateau ---
async function getBoardEnds(page) {
    return await page.evaluate(() => {
        const els = document.querySelectorAll('.domino_board .domino');
        if (els.length === 0) return null;
        const getVal = (el, side) => {
            const half = el.querySelector(`.domino_${side}`);
            return half ? (half.dataset?.value || half.getAttribute('data-value') || half.textContent.trim()) : null;
        };
        return {
            left: getVal(els[0], 'left'),
            right: getVal(els[els.length - 1], 'right')
        };
    });
}

// --- Récupération des dominos jouables (avec handles) ---
async function getPlayableDominoes(page) {
    const handles = await page.$$('.mx_2.domino.cursor_pointer');
    const dominoes = [];
    for (const handle of handles) {
        const info = await handle.evaluate(el => {
            const left = el.querySelector('.domino_left');
            const right = el.querySelector('.domino_right');
            const lv = left ? (left.dataset?.value || left.getAttribute('data-value') || left.textContent.trim()) : '?';
            const rv = right ? (right.dataset?.value || right.getAttribute('data-value') || right.textContent.trim()) : '?';
            return {
                value: `${lv}:${rv}`,
                leftVal: lv,
                rightVal: rv,
                index: el.getAttribute('data-index')
            };
        });
        dominoes.push({ handle, ...info });
    }
    return dominoes;
}

// --- Choix du meilleur domino ---
function chooseBestDomino(hand, ends) {
    if (!ends || hand.length === 0) return hand[0];
    const { left, right } = ends;
    // Double parfait
    for (const d of hand) {
        if ((d.leftVal === left && d.rightVal === right) || (d.leftVal === right && d.rightVal === left)) return d;
    }
    // Priorité aux doubles correspondant à une extrémité
    for (const d of hand) {
        if (d.leftVal === d.rightVal && (d.leftVal === left || d.leftVal === right)) return d;
    }
    // Sinon premier qui correspond
    for (const d of hand) {
        if (d.leftVal === left || d.rightVal === left || d.leftVal === right || d.rightVal === right) return d;
    }
    // Si aucun ne correspond, on prend le premier de la main
    return hand[0];
}

// --- Jouer un tour ---
async function playTurn(page) {
    const ends = await getBoardEnds(page);
    console.log('🎯 Extrémités :', ends);
    const hand = await getPlayableDominoes(page);
    console.log(`🖐️ ${hand.length} dominos jouables`);
    hand.forEach(d => console.log(`   ${d.value} (index ${d.index})`));

    if (hand.length === 0) {
        console.log('🤷 Aucun domino jouable, pioche...');
        const piocheBtn = await findButtonByText(page, 'Piocher');
        if (piocheBtn) {
            await piocheBtn.click();
            console.log('🃏 Pioche');
        }
        await delay(1000);
        return;
    }

    const chosen = chooseBestDomino(hand, ends);
    console.log(`🎯 Choix : ${chosen.value}`);

    // Double‑clic sur le domino choisi
    await chosen.handle.click();
    await delay(200);
    await chosen.handle.click();

    // Valider le coup
    const jouerBtn = await findButtonByText(page, 'Jouer');
    if (jouerBtn) {
        await jouerBtn.click();
        console.log('🖱️ Jouer');
    } else {
        await page.keyboard.press('Enter');
        console.log('⏎ Entrée');
    }
    await delay(2000);
}

// --- Boucle de jeu ---
async function gameLoop(page, maxTurns = 100) {
    for (let turn = 0; turn < maxTurns; turn++) {
        console.log(`\n🔄 Tour ${turn + 1}`);
        await playTurn(page);
        const board = await page.$('.domino_board');
        if (!board) {
            console.log('🏁 Partie terminée');
            break;
        }
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

        // 2. Domino
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

        // 3. Création partie
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
        // Conditions off
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

        // 5. Jouer
        await gameLoop(page);

        await browser.close();
        process.exit(0);
    } catch (err) {
        console.error('❌', err.message);
        if (browser) await browser.close();
        process.exit(1);
    }
})();
