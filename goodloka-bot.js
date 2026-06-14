// goodloka-bot.js – Bot de domino GoodLoka (correction faux positifs fin de manche)
const { connect } = require('puppeteer-real-browser');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

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

const recordingsDir = path.join(__dirname, 'recordings');
if (!fs.existsSync(recordingsDir)) fs.mkdirSync(recordingsDir, { recursive: true });

let ffmpegProcess = null;

function startRecording(filename = 'game_recording.mp4') {
    const filepath = path.join(recordingsDir, filename);
    console.log('🎥 Démarrage de l’enregistrement vidéo...');
    ffmpegProcess = spawn('ffmpeg', [
        '-f', 'x11grab',
        '-video_size', '1280x720',
        '-i', ':99',
        '-codec:v', 'libx264',
        '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',
        filepath
    ], { stdio: 'ignore' });
    ffmpegProcess.on('error', (err) => console.error('❌ Erreur ffmpeg:', err.message));
}

function stopRecording() {
    if (ffmpegProcess) {
        console.log('🛑 Arrêt de l’enregistrement vidéo.');
        ffmpegProcess.kill('SIGINT');
        ffmpegProcess = null;
    }
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- Utilitaires DOM ---
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

// --- Lecture du jeu ---
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

async function getFullHand(page) {
    return await page.evaluate(() => {
        const boardDominoes = [...document.querySelectorAll('.domino_board .domino')];
        const allDominoes = [...document.querySelectorAll('.domino')];
        return allDominoes
            .filter(d => !boardDominoes.includes(d))
            .map(d => {
                const left = d.querySelector('.domino_left');
                const right = d.querySelector('.domino_right');
                const lv = left ? (left.dataset?.value || left.getAttribute('data-value') || left.textContent.trim()) : '?';
                const rv = right ? (right.dataset?.value || right.getAttribute('data-value') || right.textContent.trim()) : '?';
                return {
                    value: `${lv}:${rv}`,
                    leftVal: lv,
                    rightVal: rv,
                    playable: d.classList.contains('cursor_pointer')
                };
            });
    });
}

// --- Suivi des dominos joués (stratégie) ---
let playedDominoes = new Set();

function normalize(v1, v2) {
    const a = parseInt(v1);
    const b = parseInt(v2);
    return a <= b ? `${a}:${b}` : `${b}:${a}`;
}

async function updatePlayedDominoes(page) {
    const dominoes = await page.evaluate(() => {
        const els = document.querySelectorAll('.domino_board .domino');
        return [...els].map(el => {
            const left = el.querySelector('.domino_left');
            const right = el.querySelector('.domino_right');
            const lv = left ? (left.dataset?.value || left.getAttribute('data-value') || left.textContent.trim()) : '?';
            const rv = right ? (right.dataset?.value || right.getAttribute('data-value') || right.textContent.trim()) : '?';
            return { left: lv, right: rv };
        });
    });
    dominoes.forEach(d => {
        if (d.left !== '?' && d.right !== '?') {
            playedDominoes.add(normalize(d.left, d.right));
        }
    });
}

// --- Stratégie avancée ---
function countRemainingWithValue(val, playedSet) {
    let count = 0;
    for (let i = 0; i <= 6; i++) {
        const dom = normalize(val, i);
        if (!playedSet.has(dom)) count++;
    }
    return count;
}

function scoreMove(domino, ends, hand, playedSet) {
    let score = 0;
    const { left, right } = ends;
    const valLeft = parseInt(domino.leftVal);
    const valRight = parseInt(domino.rightVal);

    const matchesLeft = (valLeft === parseInt(left) || valRight === parseInt(left));
    const matchesRight = (valLeft === parseInt(right) || valRight === parseInt(right));
    if (!matchesLeft && !matchesRight) return -Infinity;

    const newLeft = matchesLeft ? (valLeft === parseInt(left) ? valRight : valLeft) : left;
    const newRight = matchesRight ? (valLeft === parseInt(right) ? valRight : valLeft) : right;

    if (newLeft === newRight) {
        const remainingWithValue = countRemainingWithValue(newLeft, playedSet);
        score += remainingWithValue <= 1 ? 50 : 20;
    }

    const handSum = hand.reduce((sum, d) => sum + parseInt(d.leftVal) + parseInt(d.rightVal), 0);
    const dominoSum = valLeft + valRight;
    const remainingSum = handSum - dominoSum;
    score -= remainingSum * 0.5;

    if (domino.leftVal === domino.rightVal) {
        score += 10;
    }

    const myValues = new Set(hand.map(d => [d.leftVal, d.rightVal]).flat());
    if (myValues.has(newLeft.toString())) score += 5;
    if (myValues.has(newRight.toString())) score += 5;

    return score;
}

function chooseBestDomino(hand, ends, playedSet) {
    if (!ends) {
        const doubles = hand.filter(d => d.leftVal === d.rightVal);
        if (doubles.length > 0) {
            doubles.sort((a, b) => parseInt(b.leftVal) - parseInt(a.leftVal));
            return doubles[0];
        }
        hand.sort((a, b) => (parseInt(b.leftVal) + parseInt(b.rightVal)) - (parseInt(a.leftVal) + parseInt(a.rightVal)));
        return hand[0];
    }

    let best = null;
    let bestScore = -Infinity;
    for (const domino of hand) {
        const s = scoreMove(domino, ends, hand, playedSet);
        if (s > bestScore) {
            bestScore = s;
            best = domino;
        }
    }
    return best || hand[0];
}

// --- Jouer un tour avec validation ---
async function playTurn(page, previousHandCount) {
    await updatePlayedDominoes(page);

    const ends = await getBoardEnds(page);
    console.log('🎯 Extrémités :', ends);
    const hand = await getPlayableDominoes(page);
    console.log(`🖐️ ${hand.length} dominos jouables`);

    if (hand.length === 0) {
        console.log('🤷 Aucun domino jouable, le site va sauter automatiquement.');
        return 'skipped';
    }

    const chosen = chooseBestDomino(hand, ends, playedDominoes);
    console.log(`🎯 Choix : ${chosen.value} (gauche=${chosen.leftVal}, droite=${chosen.rightVal})`);

    let success = false;
    for (let attempt = 0; attempt < 3; attempt++) {
        const dominoElement = await page.evaluateHandle(({ leftVal, rightVal }) => {
            const dominos = document.querySelectorAll('.mx_2.domino.cursor_pointer');
            for (const d of dominos) {
                const left = d.querySelector('.domino_left');
                const right = d.querySelector('.domino_right');
                const lv = left ? (left.dataset?.value || left.getAttribute('data-value') || left.textContent.trim()) : null;
                const rv = right ? (right.dataset?.value || right.getAttribute('data-value') || right.textContent.trim()) : null;
                if (lv === leftVal && rv === rightVal) return d;
            }
            return null;
        }, { leftVal: chosen.leftVal, rightVal: chosen.rightVal });

        if (!dominoElement) {
            console.log(`⚠️ Tentative ${attempt + 1} : domino introuvable.`);
            await delay(300);
            continue;
        }

        const box = await dominoElement.boundingBox();
        if (!box) {
            console.log(`⚠️ Tentative ${attempt + 1} : boundingBox null.`);
            await delay(300);
            continue;
        }

        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await page.mouse.click(x, y);
        await delay(200);
        await page.mouse.click(x, y);
        success = true;
        break;
    }

    if (!success) {
        console.log('❌ Impossible de cliquer sur le domino.');
        return 'failed';
    }

    const jouerBtn = await findButtonByText(page, 'Jouer');
    if (jouerBtn) {
        await jouerBtn.click();
        console.log('🖱️ Jouer');
    } else {
        await page.keyboard.press('Enter');
        console.log('⏎ Entrée');
    }

    await delay(1500);
    const newHandCount = await page.evaluate(() => {
        const board = document.querySelectorAll('.domino_board .domino');
        const all = document.querySelectorAll('.domino');
        return all.length - board.length;
    });

    if (newHandCount >= previousHandCount) {
        console.log('⚠️ Le coup semble avoir échoué (main inchangée).');
        return 'failed';
    }

    console.log('✅ Coup joué avec succès.');
    return 'played';
}

// --- Attente de son tour ---
async function waitForMyTurn(page, timeout = 28000) {
    console.log('⏳ Attente de mon tour...');
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const element = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            return /c['’]?est votre tour/i.test(bodyText) || /à vous de jouer/i.test(bodyText);
        });
        if (element) {
            console.log('🔔 C’est mon tour !');
            return true;
        }
        await delay(1000);
    }
    console.log('⚠️ Tour non détecté dans le délai imparti.');
    return false;
}

// --- Détection de fin de manche (corrigée) ---
async function isRoundOver(page) {
    return await page.evaluate(() => {
        // Popup de fin visible avec texte explicite
        const popupSelectors = ['.modal', '.popup', '.overlay', '.victory', '.defeat'];
        for (const sel of popupSelectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) {
                if (/a gagné|manche terminée|score final|revanche/i.test(el.textContent)) return true;
            }
        }
        // Texte dans la page, mais pas si on voit "c'est votre tour"
        const bodyText = document.body.innerText.toLowerCase();
        if (/a gagné|manche terminée|score final|revanche/i.test(bodyText) &&
            !/c['’]?est votre tour|à vous de jouer/i.test(bodyText)) {
            return true;
        }
        // Boutons de fin visibles ET plateau absent
        const buttons = [...document.querySelectorAll('button')];
        const endTexts = ['rejouer', 'suivant', 'menu', 'quitter'];
        const hasEndButton = buttons.some(btn => endTexts.some(t => btn.textContent.trim().toLowerCase().includes(t)) && btn.offsetParent !== null);
        const board = document.querySelector('.domino_board');
        if (hasEndButton && !board) {
            return true;
        }
        return false;
    });
}

// --- Détection de fin de match complet ---
async function isMatchOver(page) {
    return await page.evaluate(() => {
        const bodyText = document.body.innerText.toLowerCase();
        return /a remporté le match|match terminé|vous avez gagné|vous avez perdu|score final/i.test(bodyText);
    });
}

// --- Jouer une manche complète ---
async function playOneRound(page, roundNumber) {
    console.log(`\n🎲 Début de la manche ${roundNumber}`);
    await delay(3000);
    playedDominoes.clear();
    let turn = 1;

    while (true) {
        const board = await page.$('.domino_board');
        if (!board) {
            console.log('⚠️ Plateau disparu, attente...');
            await delay(2000);
            if (await isRoundOver(page)) break;
            continue;
        }

        const myTurn = await waitForMyTurn(page);
        if (!myTurn) {
            console.log('⏰ Tour manqué.');
            await delay(2000);
            continue;
        }

        // Vérifier fin de manche après avoir obtenu le tour
        if (await isRoundOver(page)) {
            console.log('🏁 Fin de manche détectée avant le coup.');
            break;
        }

        const fullHand = await getFullHand(page);
        console.log(`🃏 Main complète (tour ${turn}, ${fullHand.length} dominos) :`);
        fullHand.forEach(d => console.log(`   ${d.playable ? '✔️' : '✖️'} ${d.value}`));

        const handSizeBefore = fullHand.length;
        const result = await playTurn(page, handSizeBefore);
        if (result === 'failed') {
            console.log('⚠️ Échec du coup, on attend le tour suivant.');
        }

        if (await isRoundOver(page)) {
            console.log('🏁 Fin de manche après le coup.');
            break;
        }

        turn++;
        if (turn > 200) {
            console.log('⚠️ Trop de tours, arrêt de la manche.');
            break;
        }
        await delay(2000);
    }

    console.log('⏳ Attente de 8 secondes pour la transition...');
    await delay(8000);
}

// --- Main ---
(async () => {
    let browser;
    try {
        const { browser: br, page } = await connect({
            headless: false,
            turnstile: false,
            args: [
                '--no-sandbox',
                '--disable-save-password-bubble',
                '--disable-features=PasswordManager',
                '--display=:99'
            ]
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

        // 4. Attente adversaire première manche
        console.log('⏳ Attente adversaire pour la première manche...');
        const startWait = Date.now();
        while (Date.now() - startWait < waitTimeout) {
            if ((await page.$('.domino_board')) || (await findButtonByText(page, 'Jouer'))) {
                console.log('🎮 Première manche commencée !');
                break;
            }
            await delay(10000);
        }

        startRecording();

        // 5. Boucle des manches
        let roundNumber = 1;
        while (true) {
            await playOneRound(page, roundNumber);

            if (await isMatchOver(page)) {
                console.log('🏆 Match terminé.');
                break;
            }

            console.log('⏳ Attente de la prochaine manche...');
            let newRound = false;
            const waitStart = Date.now();
            while (Date.now() - waitStart < 120000) {
                if (await isMatchOver(page)) break;
                const board = await page.$('.domino_board');
                const myTurn = await page.evaluate(() => {
                    const bodyText = document.body.innerText;
                    return /c['’]?est votre tour/i.test(bodyText) || /à vous de jouer/i.test(bodyText);
                });
                if (board && myTurn) {
                    const endBtns = await page.evaluate(() => {
                        const endTexts = ['rejouer', 'suivant', 'menu', 'quitter'];
                        return [...document.querySelectorAll('button')].some(btn =>
                            endTexts.some(t => btn.textContent.trim().toLowerCase().includes(t))
                        );
                    });
                    if (!endBtns) {
                        newRound = true;
                        break;
                    }
                }
                await delay(3000);
            }
            if (!newRound) {
                console.log('⚠️ Nouvelle manche non détectée, arrêt.');
                break;
            }
            roundNumber++;
        }

        stopRecording();
        await browser.close();
        process.exit(0);
    } catch (err) {
        console.error('❌', err.message);
        stopRecording();
        if (browser) await browser.close();
        process.exit(1);
    }
})();
