// ==UserScript==
// @name         OGame ROI Advisor
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Calculates the top 20 most profitable investments (Mines, Lifeform Buildings, Lifeform Techs, Plasma) based on ROI.
// @author       belveste
// @match        *://*.ogame.gameforge.com/game/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ==========================================
    // CONFIGURATION & CONSTANTS
    // ==========================================
    const CONFIG = {
        CACHE_KEY: 'ogame_roi_advisor_data',
        CACHE_DURATION: 1000 * 60 * 60, // 1 hour cache validation
        DEBUG: true // Toggle for console logging
    };

    const GAME_DATA = {
        resources: {
            metal: { baseFactor: 1.5 },
            crystal: { baseFactor: 1.6 },
            deuterium: { baseFactor: 1.5 }
        },
        lifeform_buildings: {
            // Rock'tal Magma Forge (Boosts Metal)
            'Magma Forge': {
                baseCost: { metal: 10000, crystal: 8000, deuterium: 1000 },
                costFactor: 1.4,
                bonusType: 'metal',
                bonusPerLevel: 0.0125 // ~1.25%
            },
            // Rock'tal Crystal Refinery (Boosts Crystal)
            'Crystal Refinery': {
                baseCost: { metal: 85000, crystal: 44000, deuterium: 25000 },
                costFactor: 1.4,
                bonusType: 'crystal',
                bonusPerLevel: 0.01 // ~1%
            },
            // Rock'tal Deuterium Synthesizer (Direct Production)
            'Deuterium Synthesizer': {
                baseCost: { metal: 120000, crystal: 50000, deuterium: 20000 },
                costFactor: 1.5,
                productionType: 'deuterium'
            }
        }
    };

    function log(...args) {
        if (CONFIG.DEBUG) console.log('[ROI Advisor]', ...args);
    }

    // ==========================================
    // MODULE: DATA FETCHER
    // ==========================================
    class DataFetcher {
        constructor() {
            this.state = this.loadState();
        }

        loadState() {
            const stored = localStorage.getItem(CONFIG.CACHE_KEY);
            if (stored) {
                try {
                    const parsed = JSON.parse(stored);
                    if (Date.now() - parsed.timestamp < CONFIG.CACHE_DURATION) {
                        return parsed.data;
                    }
                } catch (e) {
                    console.error('Failed to parse cache', e);
                }
            }
            return null;
        }

        saveState(data) {
            const cache = { timestamp: Date.now(), data: data };
            localStorage.setItem(CONFIG.CACHE_KEY, JSON.stringify(cache));
            this.state = data;
        }

        async fetchAllData(forceRefresh = false) {
            if (!forceRefresh && this.state) {
                log('Using cached data');
                return this.state;
            }

            log('Fetching fresh data...');

            // Helper to catch context
            const wrap = async (p, name) => {
                try {
                    return await p;
                } catch (e) {
                    throw new Error(`${name} failed: ${e.message}`);
                }
            };

            try {
                // 1. Fetch Empire View (Mines, Planet IDs, Building Levels)
                const empireData = await wrap(this.fetchEmpire(), 'Empire View');

                // 2. Fetch LF Bonuses (Current multipliers)
                const lfBonuses = await wrap(this.fetchLFBonuses(), 'LF Bonuses');

                // 3. Fetch Resource Settings (Plasma, Officer, Geologist)
                const resourceSettings = await wrap(this.fetchResourceSettings(), 'Settings');

                // Combine data
                const fullData = {
                    empire: empireData,
                    bonuses: lfBonuses,
                    settings: resourceSettings,
                    timestamp: Date.now()
                };

                this.saveState(fullData);
                return fullData;
            } catch (error) {
                console.error('detailed_error', error);
                alert(`ROI Advisor Error: ${error.message}\n(See Console for full dump)`);
                throw error;
            }
        }

        async fetchEmpire() {
            // Primary strategy: OGame Ajax Empire View
            // This often fails if "Commander" is not active or server blocks it.
            const url = '/game/index.php?page=ajax&component=empire&ajax=1&asJson=1';

            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const text = await response.text();

                // If text starts with "An error", the server rejected it.
                if (text.includes('An error has occured') || text.trim().startsWith('<')) {
                    throw new Error('API request rejected or returned HTML');
                }

                return JSON.parse(text);
            } catch (e) {
                console.warn('[ROI Advisor] Empire API failed, switching to DOM Scraper Fallback:', e.message);
                return this.fetchEmpireFallback();
            }
        }

        /**
         * Fallback: Parse data from the current page's resources or building list.
         */
        async fetchEmpireFallback() {
            log('Running Fallback Parser...');

            // 1. Get Current Planet Name/ID
            const planetIdMatch = document.querySelector('meta[name="ogame-planet-id"]');
            const planetNameMatch = document.querySelector('meta[name="ogame-planet-name"]');

            const pId = planetIdMatch ? planetIdMatch.content : 'current';
            const pName = planetNameMatch ? planetNameMatch.content : 'Current Planet';

            // Defines IDs
            const TECH_IDS = { metal: 1, crystal: 2, deuterium: 3 };

            // Helper to extract level from a DOM container (document or parsed fragment)
            const extractLevelFromDom = (root, techId) => {
                // Selector strategy:
                // .technology[data-technology="1"] .level[data-value]
                // or .technology[data-technology="1"] .amount[data-value]

                const node = root.querySelector(`[data-technology="${techId}"]`);
                if (!node) return null;

                // 1. Check .level (standard)
                let span = node.querySelector('.level');
                if (span) return parseInt(span.getAttribute('data-value') || span.innerText) || 0;

                // 2. Check .amount (sometimes used)
                span = node.querySelector('.amount');
                if (span) return parseInt(span.getAttribute('data-value') || span.innerText) || 0;

                // 3. Check data-value on the node itself (sometimes in mobile view)
                if (node.hasAttribute('data-value')) return parseInt(node.getAttribute('data-value'));

                return null;
            };

            const levels = { metal: 0, crystal: 0, deuterium: 0 };
            let foundOnPage = false;

            // STRATEGY A: Scan Current Page (Fastest)
            // If user is on 'Resources' page (component=supplies), the nodes are right here.
            log('Scanning current page DOM...');
            if (extractLevelFromDom(document, 1) !== null) {
                levels.metal = extractLevelFromDom(document, 1);
                levels.crystal = extractLevelFromDom(document, 2);
                levels.deuterium = extractLevelFromDom(document, 3);
                foundOnPage = true;
                log('Found levels on current page:', levels);
            }

            // STRATEGY B: Fetch 'supplies' component if not found
            if (!foundOnPage) {
                log('Levels not on current page. Fetching supplies...');
                const suppliesUrl = '/game/index.php?page=ingame&component=supplies&ajax=1';
                try {
                    const resp = await fetch(suppliesUrl);
                    const raw = await resp.text();

                    // The API likely returns JSON with HTML in 'content'.
                    // Try parsing as JSON first.
                    let htmlContent = raw;
                    try {
                        const json = JSON.parse(raw);
                        if (json.content) htmlContent = json.content;
                    } catch (e) { }

                    // Parse the HTML string
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(htmlContent, 'text/html');

                    levels.metal = extractLevelFromDom(doc, 1) || 0;
                    levels.crystal = extractLevelFromDom(doc, 2) || 0;
                    levels.deuterium = extractLevelFromDom(doc, 3) || 0;

                    log('Parsed levels from fetch:', levels);

                } catch (e) {
                    console.error('Fallback Fetch Error:', e);
                }
            }

            // 3. Lifeform Levels
            // We need to fetch LF levels too.
            const lfLevels = await this.fetchLifeformLevelsFallback(pId);

            return {
                planets: [{
                    id: pId,
                    name: pName,
                    buildings: { ...levels, ...lfLevels }
                }]
            };
        }

        async fetchLifeformLevelsFallback(planetId) {
            try {
                // STRATEGY A: Check current page (if user is on Lifeform Buildings)
                // IDs: Magma Forge(11202), Crystal Refinery(11203), Deut Synth(11204)

                const found = {};

                // Helper to find Tech in a root
                const scanRoot = (root) => {
                    // Rock'tal IDs: 
                    const ID_MAP = {
                        'Magma Forge': 11202,
                        'Crystal Refinery': 11203,
                        'Deuterium Synthesizer': 11204
                    };

                    for (const [name, id] of Object.entries(ID_MAP)) {
                        const node = root.querySelector(`[data-technology="${id}"]`);
                        if (node) {
                            const lvlSpan = node.querySelector('.level');
                            const lvl = parseInt(lvlSpan?.getAttribute('data-value') || lvlSpan?.innerText || 0);
                            found[name] = lvl;
                        }
                    }
                };

                // Scan Document
                scanRoot(document);

                // STRATEGY B: Fetch if not found
                if (Object.keys(found).length === 0) {
                    const lfUrl = '/game/index.php?page=ingame&component=lifeformbuildings&ajax=1';
                    const resp = await fetch(lfUrl);
                    const raw = await resp.text();
                    let html = raw;
                    try {
                        const json = JSON.parse(raw);
                        if (json.content) html = json.content;
                    } catch (e) { }

                    const parser = new DOMParser();
                    const doc = parser.parseFromString(html, 'text/html');
                    scanRoot(doc);
                }

                log('Parsed LF Levels:', found);
                return found;
            } catch (e) {
                console.warn('LF Fallback failed', e);
                return {};
            }
        }

        async fetchLFBonuses() {
            const url = '/game/index.php?page=ingame&component=lfbonuses&ajax=1';
            const response = await fetch(url);
            const text = await response.text();
            try {
                return JSON.parse(text);
            } catch (e) {
                return { raw: text };
            }
        }

        async fetchResourceSettings() {
            const url = '/game/index.php?page=ingame&component=resourceSettings&ajax=1';
            const response = await fetch(url);
            const text = await response.text();
            return {
                plasmaTech: 0,
                geologist: false
            };
        }
    }

    // ==========================================
    // MODULE: CALCULATOR
    // ==========================================
    class Calculator {
        constructor() {
            this.tradeRate = { metal: 1, crystal: 1.5, deuterium: 3 };
        }

        generateRecommendations(data) {
            const recommendations = [];
            const empire = data.empire;
            if (!empire || !empire.planets) {
                log('Invalid empire data structure', empire);
                return [];
            }

            empire.planets.forEach(planet => {
                this.addMineROI(planet, recommendations, data);
                this.addLfBuildingROI(planet, recommendations, data);
            });

            this.addPlasmaTechROI(empire.planets, recommendations, data);
            recommendations.sort((a, b) => a.paybackHours - b.paybackHours);
            return recommendations.slice(0, 20);
        }

        addMineROI(planet, list, data) {
            ['metal', 'crystal', 'deuterium'].forEach(res => {
                const currentLevel = planet.buildings ? (planet.buildings[res] || 0) : 0;
                const nextLevel = currentLevel + 1;
                const cost = this.getMineCost(res, nextLevel);
                const prodCurrent = this.getMineProduction(res, currentLevel, planet, data);
                const prodNext = this.getMineProduction(res, nextLevel, planet, data);
                const deltaProd = prodNext - prodCurrent;
                const costMSE = this.toMSE(cost);
                const prodMSE = deltaProd * this.tradeRate[res];

                if (prodMSE > 0) {
                    list.push({
                        planetName: planet.name,
                        name: `${res.charAt(0).toUpperCase() + res.slice(1)} Mine Lvl ${nextLevel}`,
                        type: 'Mine',
                        paybackHours: costMSE / prodMSE
                    });
                }
            });
        }

        addPlasmaTechROI(planets, list, data) {
            const currentPlasma = data.settings.plasmaTech || 0;
            const nextPlasma = currentPlasma + 1;
            const cost = {
                metal: 2000 * Math.pow(2, currentPlasma),
                crystal: 4000 * Math.pow(2, currentPlasma),
                deuterium: 1000 * Math.pow(2, currentPlasma)
            };
            let totalDeltaMSE = 0;
            planets.forEach(planet => {
                const mLevel = planet.buildings ? (planet.buildings.metal || 0) : 0;
                const cLevel = planet.buildings ? (planet.buildings.crystal || 0) : 0;
                const mBase = 30 * mLevel * Math.pow(1.1, mLevel);
                const cBase = 20 * cLevel * Math.pow(1.1, cLevel);
                const deltaM = mBase * 0.01;
                const deltaC = cBase * 0.0066;
                totalDeltaMSE += (deltaM * this.tradeRate.metal) + (deltaC * this.tradeRate.crystal);
            });
            const costMSE = this.toMSE(cost);
            if (totalDeltaMSE > 0) {
                list.push({
                    planetName: 'Empire',
                    name: `Plasma Technology Lvl ${nextPlasma}`,
                    type: 'Tech',
                    paybackHours: costMSE / totalDeltaMSE
                });
            }
        }

        addLfBuildingROI(planet, list, data) {
            for (const [bName, bData] of Object.entries(GAME_DATA.lifeform_buildings)) {
                let currentLevel = 0;
                if (planet.buildings && planet.buildings[bName]) {
                    currentLevel = planet.buildings[bName];
                }
                const nextLevel = currentLevel + 1;
                const cost = this.getLfCost(bData.baseCost, bData.costFactor, nextLevel);
                const costMSE = this.toMSE(cost);
                let valueMSE = 0;

                if (bData.bonusType) {
                    let baseProd = 0;
                    if (bData.bonusType === 'metal') {
                        const lvl = planet.buildings ? (planet.buildings.metal || 0) : 0;
                        baseProd = 30 * lvl * Math.pow(1.1, lvl);
                    } else if (bData.bonusType === 'crystal') {
                        const lvl = planet.buildings ? (planet.buildings.crystal || 0) : 0;
                        baseProd = 20 * lvl * Math.pow(1.1, lvl);
                    }
                    const productionGain = baseProd * bData.bonusPerLevel;
                    valueMSE = productionGain * (this.tradeRate[bData.bonusType] || 1);
                } else if (bData.productionType) {
                    const temp = planet.temperature ? planet.temperature.max : 20;
                    const tempFactor = (1.36 - 0.004 * temp);
                    const prodCurrent = 10 * currentLevel * Math.pow(1.101, currentLevel) * tempFactor;
                    const prodNext = 10 * nextLevel * Math.pow(1.101, nextLevel) * tempFactor;
                    const productionGain = prodNext - prodCurrent;
                    valueMSE = productionGain * (this.tradeRate[bData.productionType] || 1);
                }

                if (valueMSE > 0) {
                    list.push({
                        planetName: planet.name,
                        name: `${bName} Lvl ${nextLevel}`,
                        type: 'Lifeform',
                        paybackHours: costMSE / valueMSE
                    });
                }
            }
        }

        getMineCost(resource, level) {
            const costs = { metal: 0, crystal: 0, deuterium: 0 };
            const exponent = resource === 'metal' || resource === 'crystal' ? 1.5 : 1.6;
            let baseM = 0; let baseC = 0;
            if (resource === 'metal') { baseM = 60; baseC = 15; }
            else if (resource === 'crystal') { baseM = 48; baseC = 24; }
            else if (resource === 'deuterium') { baseM = 225; baseC = 75; }
            costs.metal = Math.floor(baseM * Math.pow(exponent, level - 1));
            costs.crystal = Math.floor(baseC * Math.pow(exponent, level - 1));
            return costs;
        }

        getLfCost(baseCost, factor, level) {
            const costs = { metal: 0, crystal: 0, deuterium: 0 };
            const mult = Math.pow(factor, level - 1);
            costs.metal = Math.floor((baseCost.metal || 0) * mult);
            costs.crystal = Math.floor((baseCost.crystal || 0) * mult);
            costs.deuterium = Math.floor((baseCost.deuterium || 0) * mult);
            return costs;
        }

        getMineProduction(resource, level, planet, data) {
            if (level === 0) return 0;
            let base = 0;
            if (resource === 'metal') base = 30 * level * Math.pow(1.1, level);
            else if (resource === 'crystal') base = 20 * level * Math.pow(1.1, level);
            else if (resource === 'deuterium') {
                const temp = planet.temperature ? planet.temperature.max : 20;
                base = 10 * level * Math.pow(1.1, level) * (1.44 - 0.004 * temp);
            }
            const serverSpeed = 1;
            let plasmaBonus = 0;
            const plasmaLvl = data.settings.plasmaTech || 0;
            if (resource === 'metal') plasmaBonus = 0.01 * plasmaLvl;
            else if (resource === 'crystal') plasmaBonus = 0.0066 * plasmaLvl;
            const totalMult = serverSpeed * (1 + plasmaBonus);
            return base * totalMult;
        }

        toMSE(costObject) {
            return (costObject.metal * this.tradeRate.metal) +
                (costObject.crystal * this.tradeRate.crystal) +
                (costObject.deuterium * this.tradeRate.deuterium);
        }
    }

    // ==========================================
    // MODULE: UI MANAGER
    // ==========================================
    class UIManager {
        constructor(onClickHandlers) {
            this.onClickHandlers = onClickHandlers;
            this.init();
        }

        init() {
            this.injectButton();
            this.createModal();
        }

        injectButton() {
            log('Injecting Button...');
            const tryInject = () => {
                const menu = document.querySelector('#menuTable') || document.querySelector('#menuButtons');
                if (menu) {
                    if (document.getElementById('roi-advisor-btn-li')) return true;

                    const li = document.createElement('li');
                    li.id = 'roi-advisor-btn-li';
                    li.className = 'menubutton_table';

                    const a = document.createElement('a');
                    a.className = 'menubutton';
                    a.href = 'javascript:void(0);';
                    a.style.display = 'block';

                    const span = document.createElement('span');
                    span.className = 'textlabel';
                    span.innerText = 'ROI Advisor';
                    span.style.color = '#a4c2f4'; // Light Blue

                    a.appendChild(span);
                    a.addEventListener('click', this.onClickHandlers.onOpen);
                    li.appendChild(a);

                    menu.appendChild(li); // Appends to bottom of sidebar
                    log('Button Injected Successfully into', menu.id);
                    return true;
                }
                return false;
            };

            // Attempt loop
            if (!tryInject()) {
                const interval = setInterval(() => {
                    if (tryInject()) clearInterval(interval);
                }, 500);
            }
        }

        createModal() {
            const modalId = 'roi-advisor-modal';
            if (document.getElementById(modalId)) return;

            const modal = document.createElement('div');
            modal.id = modalId;
            modal.style.cssText = `
                position: fixed;
                top: 50%; left: 50%;
                transform: translate(-50%, -50%);
                width: 600px; max-height: 80vh;
                background: #161a23;
                border: 1px solid #3d4a63;
                z-index: 9999;
                display: none;
                flex-direction: column;
                color: #fff;
                font-family: Arial, sans-serif;
                box-shadow: 0 0 20px rgba(0,0,0,0.8);
            `;

            const header = document.createElement('div');
            header.style.cssText = `
                padding: 10px;
                background: #212938;
                border-bottom: 1px solid #3d4a63;
                display: flex; justify-content: space-between; align-items: center;
                cursor: move;
            `;
            header.innerHTML = '<strong>ROI Advisor</strong>';

            const closeBtn = document.createElement('button');
            closeBtn.innerText = 'X';
            closeBtn.style.cssText = 'background:none; border:none; color:#faa; cursor:pointer; font-weight:bold;';
            closeBtn.onclick = () => { modal.style.display = 'none'; };
            header.appendChild(closeBtn);

            const refreshBtn = document.createElement('button');
            refreshBtn.innerText = 'Refresh';
            refreshBtn.style.cssText = `
                margin-left: auto; margin-right: 10px;
                background: #334455; color: white; border: 1px solid #556677;
                cursor: pointer; padding: 2px 8px; border-radius: 3px;
            `;
            refreshBtn.onclick = this.onClickHandlers.onRefresh;
            header.insertBefore(refreshBtn, closeBtn);

            const content = document.createElement('div');
            content.id = 'roi-advisor-content';
            content.style.cssText = 'padding: 10px; overflow-y: auto;';

            modal.appendChild(header);
            modal.appendChild(content);
            document.body.appendChild(modal);
        }

        showModal() {
            const modal = document.getElementById('roi-advisor-modal');
            if (modal) {
                modal.style.display = 'flex';
                this.renderLoading();
            }
        }

        renderLoading() {
            const content = document.getElementById('roi-advisor-content');
            if (content) content.innerHTML = '<p style="text-align:center;">Calculating...</p>';
        }

        renderResults(results) {
            const content = document.getElementById('roi-advisor-content');
            if (!content) return;
            if (results.length === 0) {
                content.innerHTML = '<p>No profitable upgrades found.</p>';
                return;
            }
            let html = '<table style="width:100%; border-collapse: collapse; font-size: 12px;">';
            html += '<tr style="background:#28303f; text-align:left;"><th>Planet</th><th>Upgrade</th><th>Payback</th></tr>';
            results.forEach((item, index) => {
                const bg = index % 2 === 0 ? 'transparent' : '#1e242f';
                const days = Math.floor(item.paybackHours / 24);
                const hrs = Math.floor(item.paybackHours % 24);
                html += `<tr style="background:${bg}; border-bottom: 1px solid #333;">
                        <td style="padding:5px;">${item.planetName}</td>
                        <td style="padding:5px; color:#d29d00;">${item.name}</td>
                        <td style="padding:5px;">${days}d ${hrs}h</td>
                    </tr>`;
            });
            html += '</table>';
            content.innerHTML = html;
        }
    }

    class ROIAdvisor {
        constructor() {
            this.fetcher = new DataFetcher();
            this.calculator = new Calculator();
            this.ui = new UIManager({
                onOpen: () => this.handleOpen(),
                onRefresh: () => this.handleRefresh()
            });
        }
        async handleOpen() {
            this.ui.showModal();
            const data = await this.fetcher.fetchAllData(false);
            const recommendations = this.calculator.generateRecommendations(data);
            this.ui.renderResults(recommendations);
        }
        async handleRefresh() {
            this.ui.renderLoading();
            const data = await this.fetcher.fetchAllData(true);
            const recommendations = this.calculator.generateRecommendations(data);
            this.ui.renderResults(recommendations);
        }
    }

    new ROIAdvisor();

})();
