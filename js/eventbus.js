// js/eventbus.js
// Serce architektury — wszystkie moduły komunikują się TYLKO przez Bus

class EventBus {
    constructor() { this._listeners = {}; }

    subscribe(name, cb) {
        if (!this._listeners[name]) this._listeners[name] = [];
        this._listeners[name].push(cb);
    }

    unsubscribe(name, cb) {
        if (!this._listeners[name]) return;
        this._listeners[name] = this._listeners[name].filter(fn => fn !== cb);
    }

    publish(name, data = {}) {
        (this._listeners[name] || []).forEach(cb => cb(data));
    }
}

const Bus = new EventBus();

// Stałe nazw — żeby nie było literówek
const Events = {
    MONEY_COLLECTED:   'money:collected',     // { amount, x, y }
    STACK_ADDED:       'stack:added',         // { size }
    STACK_REMOVED:     'stack:removed',       // { size }
    ITEM_PICKUP:       'item:pickup',         // { itemId, x, y }
    MACHINE_RECEIVED:  'machine:received',    // { machineId }
    MACHINE_OUTPUT:    'machine:output',      // { machineId, itemType }
    UPGRADE_BOUGHT:    'upgrade:bought',      // { upgradeId, level }
    ZONE_UNLOCKED:     'zone:unlocked',       // { zoneId }
    PLAYER_MOVED:      'player:moved',        // { speed, vx, vy }
    FX_SHAKE:          'fx:shake',            // { intensity, duration }
    FX_POPUP:          'fx:popup',            // { text, duration }
    FX_PARTICLES:      'fx:particles',        // { x, y, color, count }
    RESIZE:            'game:resize',         // { width, height }
    MARKET_UPDATED:    'market:updated',      // { prices: [{typeId, price, trend}] }
    SHIP_MODULE_COMPLETED: 'ship:moduleCompleted', // { moduleId, index }
    GAME_WON:          'game:won',            // {}
    FOOTSTEP:          'player:footstep',     // {}
    ZONE_HAZARD_WARNING: 'player:zoneHazardWarning', // { zone }
    PRESTIGE_DONE:     'game:prestigeDone',   // { planetNumber, coresEarned, totalCores }
    CORE_UPGRADE_BOUGHT: 'prestige:coreUpgradeBought', // { upgradeId, level, value }
    DAILY_LOGIN:       'daily:login',         // { streak, moneyReward, coreBonus }
    DAILY_CHALLENGE_UPDATED: 'daily:challengeUpdated', // pelny obiekt wyzwania
    DAILY_CHALLENGE_CLAIMED: 'daily:challengeClaimed', // { reward }
    FX_SHOCKWAVE:      'fx:shockwave',        // { x, y, color, maxRadius } - ekspandujący pierścień
    UNLOCK_GRANTED:    'progress:unlock',     // { id, kind, name } - nowo odblokowana strefa/maszyna
    ACHIEVEMENT_UNLOCKED: 'progress:achievement', // { id, name, icon, desc } - zdobyte osiągnięcie
};

if (typeof globalThis !== 'undefined') {
    globalThis.Bus = Bus;
    globalThis.Events = Events;
}