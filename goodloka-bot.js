// goodloka-bot.js – Bot de domino GoodLoka (VERSION EXPERT RAPIDE - CORRIGÉE)
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

process.env.DISPLAY = ':99';

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
    console.log('🎥 Démarrage de l\'enregistrement vidéo...');
    ffmpegProcess = spawn('ffmpeg', [
        '-f', 'x11grab', '-video_size', '1280x720', '-i', ':99',
        '-codec:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', filepath
    ], { stdio: 'ignore' });
    ffmpegProcess.on('error', (err) => console.error('❌ Erreur ffmpeg:', err.message));
}

function stopRecording() {
    if (ffmpegProcess) { console.log('🛑 Arrêt de l\'enregistrement vidéo.'); ffmpegProcess.kill('SIGINT'); ffmpegProcess = null; }
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================
// GESTION DU DIALOGUE CHROME
// ============================================================
async function handleChromeDialog(page) {
    try {
        const btn = await page.evaluateHandle(() => {
            const allBtns = [...document.querySelectorAll('button')];
            for (const b of allBtns) {
                const txt = b.textContent.trim().toLowerCase();
                if (['never', 'save', 'enregistrer', 'jamais', 'no thanks', 'non merci'].includes(txt)) return b;
            }
            const bubbles = document.querySelectorAll('div[role="dialog"], div[role="alertdialog"]');
            for (const bubble of bubbles) {
                for (const b of bubble.querySelectorAll('button')) {
                    const txt = b.textContent.trim().toLowerCase();
                    if (['never', 'save', 'enregistrer', 'jamais', 'no thanks', 'non merci'].includes(txt)) return b;
                }
            }
            return null;
        });
        if (btn) {
            const el = btn.asElement();
            if (el) { await el.click(); console.log('🖱️ Dialogue Chrome fermé'); await delay(1000); }
            await btn.dispose();
        }
    } catch (e) {}
}

// ============================================================
// UTILITAIRES DOM
// ============================================================
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

// ============================================================
// LECTURE DU JEU
// ============================================================
async function getBoardEnds(page) {
    return await page.evaluate(() => {
        const els = document.querySelectorAll('.domino_board .domino');
        if (els.length === 0) return null;
        const getVal = (el, side) => {
            const half = el.querySelector(`.domino_${side}`);
            return half ? (half.dataset?.value || half.getAttribute('data-value') || half.textContent.trim()) : null;
        };
        return { left: getVal(els[0], 'left'), right: getVal(els[els.length - 1], 'right') };
    });
}

async function getPlayableDominoes(page) {
    const handles = await page.$$('.mx_2.domino.cursor_pointer');
    const dominoes = [];
    for (const handle of handles) {
        const info = await handle.evaluate(el => {
            const left = el.querySelector('.domino_left'), right = el.querySelector('.domino_right');
            const lv = left ? (left.dataset?.value || left.getAttribute('data-value') || left.textContent.trim()) : '?';
            const rv = right ? (right.dataset?.value || right.getAttribute('data-value') || right.textContent.trim()) : '?';
            return { value: `${lv}:${rv}`, leftVal: lv, rightVal: rv, index: el.getAttribute('data-index') };
        });
        dominoes.push({ handle, ...info });
    }
    return dominoes;
}

async function getFullHand(page) {
    return await page.evaluate(() => {
        const boardDominoes = [...document.querySelectorAll('.domino_board .domino')];
        const allDominoes = [...document.querySelectorAll('.domino')];
        return allDominoes.filter(d => !boardDominoes.includes(d)).map(d => {
            const left = d.querySelector('.domino_left'), right = d.querySelector('.domino_right');
            const lv = left ? (left.dataset?.value || left.getAttribute('data-value') || left.textContent.trim()) : '?';
            const rv = right ? (right.dataset?.value || right.getAttribute('data-value') || right.textContent.trim()) : '?';
            return { value: `${lv}:${rv}`, leftVal: lv, rightVal: rv, playable: d.classList.contains('cursor_pointer') };
        });
    });
}

// ============================================================
// SUIVI EXPERT
// ============================================================
let playedDominoes = new Set();
let opponentPassedValues = new Set();

function normalize(v1, v2) {
    const a = parseInt(v1), b = parseInt(v2);
    return a <= b ? `${a}:${b}` : `${b}:${a}`;
}

async function updatePlayedDominoes(page) {
    const dominoes = await page.evaluate(() => {
        const els = document.querySelectorAll('.domino_board .domino');
        return [...els].map(el => {
            const left = el.querySelector('.domino_left'), right = el.querySelector('.domino_right');
            const lv = left ? (left.dataset?.value || left.getAttribute('data-value') || left.textContent.trim()) : '?';
            const rv = right ? (right.dataset?.value || right.getAttribute('data-value') || right.textContent.trim()) : '?';
            return { left: lv, right: rv };
        });
    });
    dominoes.forEach(d => { if (d.left !== '?' && d.right !== '?') playedDominoes.add(normalize(d.left, d.right)); });
}

function allDominoes() {
    const all = [];
    for (let i = 0; i <= 6; i++) for (let j = i; j <= 6; j++) all.push({ left: i, right: j, value: `${i}:${j}` });
    return all;
}

function getUnknownSet(myHandValues) {
    const all = allDominoes();
    return new Set(all.filter(d => !playedDominoes.has(d.value) && !myHandValues.has(d.value)).map(d => d.value));
}

function getOpponentPossibleHand(unknownSet) {
    const possible = new Set();
    for (const dom of unknownSet) {
        const [a, b] = dom.split(':').map(Number);
        if (!opponentPassedValues.has(a) && !opponentPassedValues.has(b)) possible.add(dom);
    }
    return possible;
}

function getFamilyControl(myHandValues, unknownSet) {
    const valueCount = {};
    for (let v = 0; v <= 6; v++) {
        let myCount = 0, totalLeft = 0;
        for (const dom of myHandValues) {
            const [a, b] = dom.split(':').map(Number);
            if (a === v || b === v) myCount++;
        }
        for (const dom of unknownSet) {
            const [a, b] = dom.split(':').map(Number);
            if (a === v || b === v) totalLeft++;
        }
        valueCount[v] = { myCount, totalLeft, control: myCount / (totalLeft + myCount + 0.01) };
    }
    return valueCount;
}

// ============================================================
// STRATÉGIE EXPERT
// ============================================================
function isValidMove(domino, ends) {
    if (!ends) return true;
    const valLeft = parseInt(domino.leftVal), valRight = parseInt(domino.rightVal);
    const endLeft = parseInt(ends.left), endRight = parseInt(ends.right);
    return (valLeft === endLeft || valRight === endLeft || valLeft === endRight || valRight === endRight);
}

function simulateMove(boardEnds, domino, side) {
    const ends = { ...boardEnds };
    const val = side === 'left' ? ends.left : ends.right;
    if (domino.leftVal == val) ends[side] = domino.rightVal;
    else ends[side] = domino.leftVal;
    return ends;
}

function canWinNow(myHandPlayable, myHandAll) {
    if (myHandPlayable.length === 1 && myHandAll.length === 1) return myHandPlayable[0];
    return null;
}

function scoreMoveExpert(domino, ends, myHand, opponentPossibleHand, unknownSet, depth = 1) {
    if (depth === 0) {
        let s = 0;
        const handSum = myHand.reduce((sum, d) => sum + parseInt(d.leftVal) + parseInt(d.rightVal), 0);
        s -= (handSum - (parseInt(domino.leftVal) + parseInt(domino.rightVal))) * 0.8;
        if (domino.leftVal === domino.rightVal) s += 10;
        return s;
    }

    let bestScore = -Infinity;
    const placements = [];
    if (domino.leftVal == ends.left || domino.rightVal == ends.left) placements.push('left');
    if (domino.leftVal == ends.right || domino.rightVal == ends.right) placements.push('right');

    for (const side of placements) {
        const newEnds = simulateMove(ends, domino, side);
        const newHand = myHand.filter(d => d.value !== domino.value);
        let bonus = 0;

        if (newEnds.left === newEnds.right) {
            const remaining = [...opponentPossibleHand].filter(d => {
                const [a, b] = d.split(':').map(Number);
                return a === parseInt(newEnds.left) || b === parseInt(newEnds.left);
            }).length;
            if (remaining === 0) bonus += 200;
            else if (remaining <= 1) bonus += 80;
            else bonus += 30;
        }

        const family = getFamilyControl(new Set(newHand.map(d => d.value)), unknownSet);
        const likelyAdv = Object.entries(family).filter(([_, v]) => v.control < 0.3).map(([val]) => val);
        if (likelyAdv.includes(newEnds.left.toString())) bonus -= 20;
        if (likelyAdv.includes(newEnds.right.toString())) bonus -= 20;

        const newSum = newHand.reduce((s, d) => s + parseInt(d.leftVal) + parseInt(d.rightVal), 0);
        bonus -= newSum * 0.6;

        if (domino.leftVal === domino.rightVal) bonus += 15;

        if (depth > 0 && opponentPossibleHand.size > 0) {
            const oppHand = [...opponentPossibleHand].slice(0, 20).map(d => {
                const [a, b] = d.split(':').map(Number);
                return { value: d, leftVal: a.toString(), rightVal: b.toString() };
            });
            let worstForMe = Infinity;
            for (const oppDom of oppHand) {
                if (oppDom.leftVal == newEnds.left || oppDom.rightVal == newEnds.left ||
                    oppDom.leftVal == newEnds.right || oppDom.rightVal == newEnds.right) {
                    const sc = scoreMoveExpert(oppDom, newEnds, newHand, new Set(), unknownSet, 0);
                    if (sc < worstForMe) worstForMe = sc;
                }
            }
            if (worstForMe !== Infinity) bonus += worstForMe * 0.3;
        }

        if (bonus > bestScore) bestScore = bonus;
    }
    return bestScore;
}

function chooseBestDominoExpert(hand, ends, opponentPossibleHand, unknownSet, myHandAll) {
    const validHand = ends ? hand.filter(d => isValidMove(d, ends)) : hand;
    if (validHand.length === 0) {
        console.log('⚠️ Aucun domino valide trouvé !');
        return null;
    }

    const winNow = canWinNow(validHand, myHandAll);
    if (winNow) { console.log('🏆 COUP GAGNANT DÉTECTÉ !'); return winNow; }

    if (!ends) {
        const doubles = validHand.filter(d => d.leftVal === d.rightVal);
        if (doubles.length > 0) return doubles.sort((a, b) => parseInt(b.leftVal) - parseInt(a.leftVal))[0];
        return validHand.sort((a, b) => (parseInt(b.leftVal) + parseInt(b.rightVal)) - (parseInt(a.leftVal) + parseInt(a.rightVal)))[0];
    }

    let best = null, bestScore = -Infinity;
    for (const domino of validHand) {
        const s = scoreMoveExpert(domino, ends, validHand, opponentPossibleHand, unknownSet, 2);
        if (s > bestScore) { bestScore = s; best = domino; }
    }
    return best || validHand[0];
}

// ============================================================
// JOUER UN TOUR (RAPIDE - CORRIGÉ)
// ============================================================
async function playTurn(page, previousHandCount) {
    await updatePlayedDominoes(page);
    await handleChromeDialog(page);

    const ends = await getBoardEnds(page);
    console.log('🎯 Extrémités :', ends);
    let hand = await getPlayableDominoes(page);
    console.log(`🖐️ ${hand.length} dominos jouables`);

    if (hand.length === 0) {
        console.log('🤷 Aucun domino jouable, le site va sauter automatiquement.');
        return 'skipped';
    }

    if (ends) {
        hand = hand.filter(d => isValidMove(d, ends));
        if (hand.length === 0) {
            console.log('❌ Aucun domino valide après filtrage !');
            return 'skipped';
        }
    }

    const myHandValues = new Set((await getFullHand(page)).map(d => d.value));
    const unknownSet = getUnknownSet(myHandValues);
    const opponentPossibleHand = getOpponentPossibleHand(unknownSet);

    const chosen = chooseBestDominoExpert(hand, ends, opponentPossibleHand, unknownSet,
        [...myHandValues].map(v => {
            const [a, b] = v.split(':').map(Number);
            return { value: v, leftVal: a.toString(), rightVal: b.toString() };
        }));

    if (!chosen) {
        console.log('❌ Aucun domino choisi.');
        return 'skipped';
    }

    console.log(`🎯 Choix expert : ${chosen.value} (gauche=${chosen.leftVal}, droite=${chosen.rightVal})`);

    // DOUBLE-CLIC RAPIDE via evaluate
    let clicked = false;
    const clickedFirst = await page.evaluate(({ leftVal, rightVal }) => {
        const dominos = document.querySelectorAll('.mx_2.domino.cursor_pointer');
        for (const d of dominos) {
            const left = d.querySelector('.domino_left'), right = d.querySelector('.domino_right');
            const lv = left ? (left.dataset?.value || left.getAttribute('data-value') || left.textContent.trim()) : null;
            const rv = right ? (right.dataset?.value || right.getAttribute('data-value') || right.textContent.trim()) : null;
            if (lv === leftVal && rv === rightVal) {
                d.click();
                return true;
            }
        }
        return false;
    }, { leftVal: chosen.leftVal, rightVal: chosen.rightVal });

    if (clickedFirst) {
        await delay(80);
        await page.evaluate(({ leftVal, rightVal }) => {
            const dominos = document.querySelectorAll('.mx_2.domino.cursor_pointer');
            for (const d of dominos) {
                const left = d.querySelector('.domino_left'), right = d.querySelector('.domino_right');
                const lv = left ? (left.dataset?.value || left.getAttribute('data-value') || left.textContent.trim()) : null;
                const rv = right ? (right.dataset?.value || right.getAttribute('data-value') || right.textContent.trim()) : null;
                if (lv === leftVal && rv === rightVal) { d.click(); return true; }
            }
            return false;
        }, { leftVal: chosen.leftVal, rightVal: chosen.rightVal });
        clicked = true;
    } else {
        // Fallback souris
        for (let attempt = 0; attempt < 2; attempt++) {
            const box = await page.evaluate(({ leftVal, rightVal }) => {
                const dominos = document.querySelectorAll('.mx_2.domino.cursor_pointer');
                for (const d of dominos) {
                    const left = d.querySelector('.domino_left'), right = d.querySelector('.domino_right');
                    const lv = left ? (left.dataset?.value || left.getAttribute('data-value') || left.textContent.trim()) : null;
                    const rv = right ? (right.dataset?.value || right.getAttribute('data-value') || right.textContent.trim()) : null;
                    if (lv === leftVal && rv === rightVal) {
                        const r = d.getBoundingClientRect();
                        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                    }
                }
                return null;
            }, { leftVal: chosen.leftVal, rightVal: chosen.rightVal });
            if (box) {
                await page.mouse.click(box.x, box.y);
                await delay(80);
                await page.mouse.click(box.x, box.y);
                clicked = true;
                break;
            }
            await delay(100);
        }
    }

    if (!clicked) {
        console.log('❌ Impossible de cliquer sur le domino.');
        return 'failed';
    }

    // TROUVER LE BOUTON JOUER (CORRIGÉ avec asElement)
    await delay(200);
    const jouerBtnHandle = await page.evaluateHandle(() => {
        const buttons = [...document.querySelectorAll('button')];
        for (const btn of buttons) {
            if (btn.offsetParent === null) continue;
            const txt = btn.textContent.trim().toLowerCase();
            if (txt === 'jouer' || txt.includes('jouer') || txt === 'play' || txt.includes('valider')) return btn;
        }
        return null;
    });

    if (jouerBtnHandle) {
        const jouerBtn = jouerBtnHandle.asElement();
        if (jouerBtn) {
            await jouerBtn.click();
            console.log('🖱️ Jouer');
        } else {
            await page.keyboard.press('Enter');
            console.log('⏎ Entrée (bouton non cliquable)');
        }
        await jouerBtnHandle.dispose();
    } else {
        await page.keyboard.press('Enter');
        console.log('⏎ Entrée (bouton Jouer non trouvé)');
    }

    await delay(1000);
    return 'played';
}

// ============================================================
// DÉTECTION PÉNALITÉ
// ============================================================
async function hasPenalty(page) {
    return await page.evaluate(() => {
        const bodyText = document.body.innerText.toLowerCase();
        return /pénalité|penalty|avertissement|warning/i.test(bodyText);
    });
}

// ============================================================
// DÉTECTION DES PASSES ADVERSES
// ============================================================
async function detectOpponentPass(page, previousBoardEnds) {
    const currentEnds = await getBoardEnds(page);
    if (currentEnds && previousBoardEnds &&
        currentEnds.left === previousBoardEnds.left &&
        currentEnds.right === previousBoardEnds.right) {
        opponentPassedValues.add(parseInt(currentEnds.left));
        opponentPassedValues.add(parseInt(currentEnds.right));
        console.log(`🧠 Adversaire a passé/poché sur ${currentEnds.left} et ${currentEnds.right}`);
    }
    return currentEnds;
}

// ============================================================
// DÉTECTION FINS
// ============================================================
async function isRoundOver(page) {
    return await page.evaluate(() => {
        const bodyText = document.body.innerText.toLowerCase();
        if (/prochain round dans|next round in/i.test(bodyText)) return true;
        if (/a gagné|manche terminée|score final|revanche/i.test(bodyText) &&
            !/c['’]?est votre tour|à vous de jouer/i.test(bodyText)) return true;
        const popupSelectors = ['.modal', '.popup', '.overlay', '.victory', '.defeat'];
        for (const sel of popupSelectors) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null && /a gagné|manche terminée|score final|revanche/i.test(el.textContent)) return true;
        }
        const buttons = [...document.querySelectorAll('button')];
        const endTexts = ['rejouer', 'suivant', 'menu', 'quitter'];
        const hasEndButton = buttons.some(btn => endTexts.some(t => btn.textContent.trim().toLowerCase().includes(t)) && btn.offsetParent !== null);
        if (hasEndButton && !document.querySelector('.domino_board')) return true;
        return false;
    });
}

async function isMatchOver(page) {
    return await page.evaluate(() => {
        const bodyText = document.body.innerText.toLowerCase();
        if (/a remporté le match|match terminé|vous avez gagné|vous avez perdu|score final|victoire !|défaite !|match gagné|match perdu/i.test(bodyText)) return true;
        const buttons = [...document.querySelectorAll('button')];
        for (const btn of buttons) {
            const txt = btn.textContent.trim().toLowerCase();
            if ((txt.includes('terminé') || txt.includes('terminer') || txt.includes('quitter le match') || txt.includes('menu principal')) && btn.offsetParent !== null) return true;
        }
        return false;
    });
}

// ============================================================
// ATTENTE DU TOUR (RAPIDE)
// ============================================================
async function waitForMyTurn(page, timeout = 20000) {
    console.log('⏳ Attente de mon tour...');
    const start = Date.now();
    while (Date.now() - start < timeout) {
        await handleChromeDialog(page);
        if (await isRoundOver(page)) {
            console.log('🏁 Fin de manche détectée pendant l\'attente.');
            return 'round_over';
        }
        const board = await page.$('.domino_board');
        if (!board) { await delay(500); continue; }
        const myTurn = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            return /c['’]?est votre tour/i.test(bodyText) || /à vous de jouer/i.test(bodyText);
        });
        if (myTurn) { console.log('🔔 C\'est mon tour !'); return 'my_turn'; }
        await delay(500);
    }
    console.log('⚠️ Tour non détecté dans le délai imparti.');
    return 'timeout';
}

// ============================================================
// JOUER UNE MANCHE (EXPERT)
// ============================================================
async function playOneRound(page, roundNumber) {
    console.log(`\n🎲 Début de la manche ${roundNumber} (mode EXPERT)`);
    await delay(2000);
    playedDominoes.clear();
    opponentPassedValues.clear();
    let turn = 1, consecutiveMisses = 0;
    let previousEnds = null;

    while (true) {
        const board = await page.$('.domino_board');
        if (!board) {
            console.log('⚠️ Plateau disparu, attente...');
            const start = Date.now();
            while (Date.now() - start < 30000) {
                if (await isRoundOver(page)) { console.log('🏁 Fin de manche confirmée.'); break; }
                if (await page.$('.domino_board')) { console.log('✅ Plateau réapparu.'); break; }
                await delay(1500);
            }
            if (await isRoundOver(page)) break;
            if (!(await page.$('.domino_board'))) { console.log('⚠️ Plateau absent, fin forcée.'); break; }
            continue;
        }

        const waitResult = await waitForMyTurn(page);
        if (waitResult === 'round_over') break;
        if (waitResult === 'timeout') {
            consecutiveMisses++;
            if (consecutiveMisses >= 5) { console.log('⚠️ Trop de tours manqués, fin forcée.'); break; }
            await delay(1000); continue;
        }
        consecutiveMisses = 0;
        if (await isRoundOver(page)) break;

        // Détecter si l'adversaire a passé
        if (previousEnds) await detectOpponentPass(page, previousEnds);

        const fullHand = await getFullHand(page);
        console.log(`🃏 Main complète (tour ${turn}, ${fullHand.length} dominos) :`);
        fullHand.forEach(d => console.log(`   ${d.playable ? '✔️' : '✖️'} ${d.value}`));

        const handSizeBefore = fullHand.length;
        const result = await playTurn(page, handSizeBefore);

        if (result === 'failed' && await hasPenalty(page)) {
            console.log('⚠️ Pénalité détectée, pause de sécurité.');
            await delay(3000);
        }

        previousEnds = await getBoardEnds(page);

        if (await isRoundOver(page)) break;
        if (await isMatchOver(page)) return 'match_over';
        turn++;
        if (turn > 200) break;
        await delay(1500);
    }
    console.log('⏳ Attente de 10 secondes pour la transition...');
    await delay(10000);
    return 'round_over';
}

// ============================================================
// MAIN
// ============================================================
(async () => {
    let browser;
    try {
        const { browser: br, page } = await connect({
            headless: false,
            turnstile: false,
            args: ['--no-sandbox', '--disable-save-password-bubble', '--display=:99']
        });
        browser = br;
        await page.setViewport({ width: 1280, height: 720 });

        // 1. Login
        const loginUrl = 'https://www.goodloka.com/auth/login';
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(5000);
        await handleChromeDialog(page);
        await fillFieldHuman(page, 'input[type="text"][placeholder*="Ex"]', phone, 'téléphone');
        await fillFieldHuman(page, 'input[type="password"]', password, 'mot de passe');
        await page.keyboard.press('Enter');
        await delay(5000);

        // 2. Domino
        const gamesListUrl = 'https://www.goodloka.com/games/list';
        await page.goto(gamesListUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(5000);
        await handleChromeDialog(page);
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
                await b.click(); break;
            }
        }
        await delay(1000);
        (await findButtonByText(page, desiredScore))?.click(); await delay(500);
        (await findButtonByText(page, desiredMise))?.click(); await delay(500);
        (await findButtonByText(page, `${desiredJoueurs} joueurs`))?.click(); await delay(500);
        const allBtns = await page.$$('button');
        for (const btn of allBtns) {
            const txt = await page.evaluate(el => el.textContent.trim(), btn);
            const cls = await page.evaluate(el => el.className, btn);
            if ((txt.match(/[<>]\s*\d/) || txt.includes('📅')) && (cls.includes('active') || cls.includes('selected'))) {
                await btn.click(); await delay(300);
            }
        }
        (await findButtonByText(page, 'Créer la partie'))?.click();
        await delay(3000);

        // 4. Attente adversaire
        console.log('⏳ Attente adversaire pour la première manche...');
        const startWait = Date.now();
        while (Date.now() - startWait < waitTimeout) {
            if ((await page.$('.domino_board')) || (await findButtonByText(page, 'Jouer'))) {
                console.log('🎮 Première manche commencée !'); break;
            }
            await delay(10000);
        }

        await delay(2000);
        startRecording();

        // 5. Boucle des manches
        let roundNumber = 1;
        while (true) {
            const result = await playOneRound(page, roundNumber);
            if (result === 'match_over') break;
            if (await isMatchOver(page)) { console.log('🏆 Match terminé.'); break; }

            console.log('⏳ Attente de la prochaine manche...');
            let newRound = false;
            const waitStart2 = Date.now();
            while (Date.now() - waitStart2 < 120000) {
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
                    if (!endBtns) { newRound = true; break; }
                }
                await delay(3000);
            }
            if (!newRound) { console.log('⚠️ Nouvelle manche non détectée, arrêt.'); break; }
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
