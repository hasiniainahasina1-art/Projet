// goodloka-bot.js – Bot de domino GoodLoka (VERSION FINALE - EXPERT + VNC + CHOIX CÔTÉ + ZOOM)
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

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================
// GESTION DU DIALOGUE CHROME
// ============================================================
async function handleChromeSaveDialog(page) {
    try {
        await delay(3000);
        const clicked = await page.evaluate(() => {
            const buttons = [...document.querySelectorAll('button')];
            for (const btn of buttons) {
                const txt = btn.textContent.trim().toLowerCase();
                if (txt === 'never' || txt === 'save' || txt === 'enregistrer' || 
                    txt === 'jamais' || txt === 'no thanks' || txt === 'non merci') {
                    btn.click();
                    return txt;
                }
            }
            const dialogs = document.querySelectorAll('div[role="dialog"], div[role="alertdialog"]');
            for (const d of dialogs) {
                const btns = d.querySelectorAll('button');
                for (const btn of btns) {
                    const txt = btn.textContent.trim().toLowerCase();
                    if (txt === 'never' || txt === 'save' || txt === 'enregistrer' || 
                        txt === 'jamais' || txt === 'no thanks' || txt === 'non merci') {
                        btn.click();
                        return txt;
                    }
                }
            }
            return null;
        });
        if (clicked) {
            console.log(`🖱️ Dialogue Chrome fermé (${clicked})`);
        } else {
            await page.keyboard.press('Escape');
            console.log('⌨️ Touche Escape pressée');
        }
        await delay(1000);
    } catch (e) {}
}

// ============================================================
// ZOOM POUR VOIR TOUT L'ÉCRAN (80% pour les petits écrans)
// ============================================================
async function adjustViewForDominoes(page) {
    await page.evaluate(() => {
        document.body.style.zoom = '0.8';
        const board = document.querySelector('.domino_board');
        if (board) {
            board.scrollIntoView({ behavior: 'instant', block: 'center' });
        } else {
            window.scrollTo(0, 0);
        }
    });
}

// ============================================================
// UTILITAIRES DOM
// ============================================================
async function fillFieldHuman(page, selector, value, fieldName) {
    console.log(`⌨️ Remplissage de ${fieldName}...`);
    let attempts = 0;
    const maxAttempts = 3;
    while (attempts < maxAttempts) {
        try { await page.waitForSelector(selector, { visible: true, timeout: 10000 }); break; }
        catch (e) { attempts++; if (attempts >= maxAttempts) throw new Error(`Champ ${fieldName} introuvable`); }
    }
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await delay(100 + Math.random() * 200);
    for (const char of value) await page.keyboard.type(char, { delay: Math.floor(Math.random() * 70) + 30 });
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
        await page.mouse.move(x, y); await delay(15);
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

async function killChromePopups(page) {
    await page.evaluate(() => {
        document.querySelectorAll('div[role="dialog"], div[aria-label], .popup, .overlay, .modal').forEach(p => {
            if (p.offsetParent && !p.classList.contains('domino_board')) p.remove();
        });
        document.querySelectorAll('div.infobar, div[class*="infobar"]').forEach(i => i.style.display = 'none');
    });
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
// SUIVI DES DOMINOS JOUÉS
// ============================================================
let playedDominoes = new Set();

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

// ============================================================
// STRATÉGIE EXPERT
// ============================================================
let opponentPassedValues = new Set();

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

function countRemainingInUnknown(value, unknownSet) {
    let count = 0;
    for (const dom of unknownSet) {
        const [a, b] = dom.split(':').map(Number);
        if (a === value || b === value) count++;
    }
    return count;
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

function chooseBestDomino(hand, ends, playedSet, unknownSet, myHandAll) {
    if (!ends) {
        const doubles = hand.filter(d => d.leftVal === d.rightVal);
        if (doubles.length > 0) {
            doubles.sort((a, b) => parseInt(b.leftVal) - parseInt(a.leftVal));
            return doubles[0];
        }
        hand.sort((a, b) => (parseInt(b.leftVal) + parseInt(b.rightVal)) - (parseInt(a.leftVal) + parseInt(a.rightVal)));
        return hand[0];
    }

    const opponentPossibleHand = getOpponentPossibleHand(unknownSet);
    const winNow = canWinNow(hand, myHandAll);
    if (winNow) { console.log('🏆 COUP GAGNANT DÉTECTÉ !'); return winNow; }

    let best = null, bestScore = -Infinity;
    for (const domino of hand) {
        const s = scoreMoveExpert(domino, ends, hand, opponentPossibleHand, unknownSet, 2);
        if (s > bestScore) { bestScore = s; best = domino; }
    }
    return best || hand[0];
}

// ============================================================
// JOUER UN TOUR (AVEC GESTION DU CHOIX DE CÔTÉ)
// ============================================================
async function playTurn(page, previousHandCount, failedValues) {
    await updatePlayedDominoes(page);
    await killChromePopups(page);
    await adjustViewForDominoes(page);

    const ends = await getBoardEnds(page);
    let hand = await getPlayableDominoes(page);
    const fullHand = await getFullHand(page);

    console.log('\n┌─────────────────────────────────────────────┐');
    console.log('│ 🎮 ÉTAT DU PLATEAU                          │');
    console.log('├─────────────────────────────────────────────┤');
    
    const boardDominoes = await page.evaluate(() => {
        const els = document.querySelectorAll('.domino_board .domino');
        return [...els].map(el => {
            const left = el.querySelector('.domino_left'), right = el.querySelector('.domino_right');
            const lv = left ? (left.dataset?.value || left.getAttribute('data-value') || left.textContent.trim()) : '?';
            const rv = right ? (right.dataset?.value || right.getAttribute('data-value') || right.textContent.trim()) : '?';
            return `[${lv}|${rv}]`;
        });
    });
    
    if (boardDominoes.length === 0) {
        console.log('│ Plateau : VIDE (début de manche)');
    } else {
        console.log(`│ Plateau : ${boardDominoes.join(' ')}`);
        console.log(`│ Extrémités : ${ends.left} ← → ${ends.right}`);
    }
    
    const opponentCount = await page.evaluate(() => {
        const all = [...document.querySelectorAll('.domino')];
        const board = [...document.querySelectorAll('.domino_board .domino')];
        const mine = [...document.querySelectorAll('.mx_2.domino')];
        return all.filter(d => !board.includes(d) && !mine.includes(d)).length;
    });
    
    console.log(`│ Dominos adversaire : ${opponentCount}`);
    console.log(`│ Mes dominos : ${fullHand.length}`);
    console.log('├─────────────────────────────────────────────┤');
    console.log('│ 🃏 MA MAIN                                  │');
    fullHand.forEach((d) => {
        console.log(`│ ${d.playable ? '✅' : '❌'} [${d.leftVal}|${d.rightVal}]`);
    });
    console.log('├─────────────────────────────────────────────┤');

    if (hand.length === 0) {
        console.log('│ 🤷 Aucun domino jouable                    │');
        console.log('└─────────────────────────────────────────────┘\n');
        return { status: 'skipped' };
    }

    const myHandSet = new Set(hand.map(d => d.value));
    const unknownSet = getUnknownSet(myHandSet);
    const myHandAll = [...myHandSet].map(v => {
        const [a, b] = v.split(':').map(Number);
        return { value: v, leftVal: a.toString(), rightVal: b.toString() };
    });
    
    const chosen = chooseBestDomino(hand, ends, playedDominoes, unknownSet, myHandAll);
    console.log(`│ 🧠 CHOIX EXPERT : [${chosen.leftVal}|${chosen.rightVal}]`);
    console.log('└─────────────────────────────────────────────┘\n');

    // Double-clic sécurisé
    let success = false;
    let dominoBox = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        const dominoElement = await page.evaluateHandle(({ leftVal, rightVal }) => {
            const dominos = document.querySelectorAll('.mx_2.domino.cursor_pointer');
            for (const d of dominos) {
                const left = d.querySelector('.domino_left'), right = d.querySelector('.domino_right');
                const lv = left ? (left.dataset?.value || left.getAttribute('data-value') || left.textContent.trim()) : null;
                const rv = right ? (right.dataset?.value || right.getAttribute('data-value') || right.textContent.trim()) : null;
                if (lv === leftVal && rv === rightVal) return d;
            }
            return null;
        }, { leftVal: chosen.leftVal, rightVal: chosen.rightVal });

        if (!dominoElement) { console.log(`⚠️ Tentative ${attempt + 1} : domino introuvable.`); await delay(300); continue; }
        const box = await dominoElement.boundingBox();
        if (!box) { console.log(`⚠️ Tentative ${attempt + 1} : boundingBox null.`); await delay(300); continue; }

        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await delay(200);
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        success = true;
        dominoBox = box; // sauvegarder pour plus tard
        break;
    }

    if (!success) { console.log('❌ Impossible de cliquer sur le domino.'); return { status: 'failed', failedValue: chosen.value }; }

    // Gérer le choix du côté si le domino correspond aux deux extrémités
    if (ends) {
        const matchBothSides = (chosen.leftVal === ends.left && chosen.rightVal === ends.right) ||
                               (chosen.leftVal === ends.right && chosen.rightVal === ends.left);
        if (matchBothSides) {
            console.log('↔️ Choix de côté nécessaire (domino correspond aux deux extrémités)');
            await delay(800);
            // Essayer de trouver un bouton "Gauche" ou "Left"
            const sideBtn = await page.evaluateHandle(() => {
                const buttons = [...document.querySelectorAll('button')];
                for (const btn of buttons) {
                    const txt = btn.textContent.trim().toLowerCase();
                    if (txt === 'gauche' || txt === 'left' || txt.includes('left') || txt === '←') return btn;
                }
                return null;
            });
            if (sideBtn) {
                await sideBtn.click();
                console.log('🖱️ Côté gauche sélectionné via bouton');
            } else if (dominoBox) {
                // Cliquer à gauche du domino sélectionné pour choisir la gauche
                await page.mouse.click(dominoBox.x - 60, dominoBox.y + dominoBox.height / 2);
                console.log('🖱️ Clic à gauche du domino pour sélectionner le côté gauche');
            } else {
                // Fallback clavier
                await page.keyboard.press('ArrowLeft');
                await delay(100);
                await page.keyboard.press('Enter');
                console.log('⌨️ Flèche gauche + Entrée');
            }
            await delay(500);
        }
    }

    // Bouton Jouer
    const jouerBtn = await findButtonByText(page, 'Jouer');
    if (jouerBtn) { await jouerBtn.click(); console.log('🖱️ Jouer'); }
    else { await page.keyboard.press('Enter'); console.log('⏎ Entrée'); }

    await delay(1500);
    return { status: 'played' };
}

// ============================================================
// DÉTECTION DES PASSES
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

async function waitForMyTurnOrRoundEnd(page, timeout = 28000) {
    console.log('⏳ Attente de mon tour...');
    const start = Date.now();
    while (Date.now() - start < timeout) {
        await killChromePopups(page);
        if (await isRoundOver(page)) { console.log('🏁 Fin de manche détectée.'); return 'round_over'; }
        const board = await page.$('.domino_board');
        if (!board) { await delay(1000); continue; }
        const myTurn = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            return /c['’]?est votre tour/i.test(bodyText) || /à vous de jouer/i.test(bodyText);
        });
        if (myTurn) { console.log('🔔 C\'est mon tour !'); return 'my_turn'; }
        await delay(1000);
    }
    console.log('⚠️ Tour non détecté.');
    return 'timeout';
}

// ============================================================
// JOUER UNE MANCHE
// ============================================================
async function playOneRound(page, roundNumber) {
    console.log(`\n🎲 Début de la manche ${roundNumber} (EXPERT)`);
    await delay(3000);
    playedDominoes.clear();
    opponentPassedValues.clear();
    let turn = 1, consecutiveMisses = 0;
    let failedValues = new Set();
    let previousEnds = null;

    while (true) {
        const board = await page.$('.domino_board');
        if (!board) {
            const start = Date.now();
            while (Date.now() - start < 30000) {
                if (await isRoundOver(page)) { console.log('🏁 Fin de manche confirmée.'); break; }
                if (await page.$('.domino_board')) { console.log('✅ Plateau réapparu.'); break; }
                await delay(2000);
            }
            if (await isRoundOver(page)) break;
            if (!(await page.$('.domino_board'))) { console.log('⚠️ Plateau absent, fin forcée.'); break; }
            continue;
        }

        const waitResult = await waitForMyTurnOrRoundEnd(page);
        if (waitResult === 'round_over') break;
        if (waitResult === 'timeout') { consecutiveMisses++; if (consecutiveMisses >= 5) break; await delay(2000); continue; }
        consecutiveMisses = 0;
        if (await isRoundOver(page)) break;

        if (previousEnds) await detectOpponentPass(page, previousEnds);

        const fullHand = await getFullHand(page);
        const handSizeBefore = fullHand.length;
        const result = await playTurn(page, handSizeBefore, failedValues);

        if (result.status === 'failed') {
            if (result.failedValue) failedValues.add(result.failedValue);
            if (failedValues.size >= 3) failedValues.clear();
        } else {
            failedValues.clear();
        }

        previousEnds = await getBoardEnds(page);
        if (await isRoundOver(page)) break;
        if (await isMatchOver(page)) return 'match_over';
        turn++;
        if (turn > 200) break;
        await delay(2000);
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
            headless: false, turnstile: false,
            args: ['--no-sandbox', '--disable-save-password-bubble', '--display=:99']
        });
        browser = br;
        await page.setViewport({ width: 1280, height: 720 });

        console.log('🔗 Le navigateur est visible via VNC !\n');

        // 1. Login
        const loginUrl = 'https://www.goodloka.com/auth/login';
        await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(5000);
        await fillFieldHuman(page, 'input[type="text"][placeholder*="Ex"]', phone, 'téléphone');
        await fillFieldHuman(page, 'input[type="password"]', password, 'mot de passe');
        await page.keyboard.press('Enter');
        await delay(3000);
        await handleChromeSaveDialog(page);

        // 2. Domino
        const gamesListUrl = 'https://www.goodloka.com/games/list';
        await page.goto(gamesListUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(5000);
        await handleChromeSaveDialog(page);
        
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
        await handleChromeSaveDialog(page);

        // 3. Création partie
        const createBtn = await findButtonByText(page, 'Créer une partie');
        if (createBtn) await createBtn.click();
        await delay(3000);

        const modeBtns = await page.$$('button.mode-pill');
        for (const b of modeBtns) {
            if ((await page.evaluate(el => el.textContent.trim(), b)).includes('Classique')) { await b.click(); break; }
        }
        await delay(1000);
        (await findButtonByText(page, desiredScore))?.click(); await delay(500);
        (await findButtonByText(page, desiredMise))?.click(); await delay(500);
        (await findButtonByText(page, `${desiredJoueurs} joueurs`))?.click(); await delay(500);
        const allBtns = await page.$$('button');
        for (const btn of allBtns) {
            const txt = await page.evaluate(el => el.textContent.trim(), btn);
            const cls = await page.evaluate(el => el.className, btn);
            if ((txt.match(/[<>]\s*\d/) || txt.includes('📅')) && (cls.includes('active') || cls.includes('selected'))) { await btn.click(); await delay(300); }
        }
        (await findButtonByText(page, 'Créer la partie'))?.click();
        await delay(3000);

        // 4. Attente adversaire
        console.log('⏳ Attente adversaire pour la première manche...');
        const startWait = Date.now();
        while (Date.now() - startWait < waitTimeout) {
            if ((await page.$('.domino_board')) || (await findButtonByText(page, 'Jouer'))) { console.log('🎮 Première manche commencée !'); break; }
            await delay(10000);
        }

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
                        return [...document.querySelectorAll('button')].some(btn => endTexts.some(t => btn.textContent.trim().toLowerCase().includes(t)));
                    });
                    if (!endBtns) { newRound = true; break; }
                }
                await delay(3000);
            }
            if (!newRound) { console.log('⚠️ Nouvelle manche non détectée, arrêt.'); break; }
            roundNumber++;
        }

        await browser.close();
        process.exit(0);
    } catch (err) {
        console.error('❌', err.message);
        if (browser) await browser.close();
        process.exit(1);
    }
})();
