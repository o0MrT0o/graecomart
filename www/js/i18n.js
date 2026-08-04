'use strict';

/**
 * i18n.js
 * ------------------------------------------------------------------------
 * Przełącznik języka gry (Tomek: "zróbmy przełącznik, żeby dało się włączyć
 * cały język angielski"). Jeden globalny obiekt window.I18n - JEDYNY
 * świadomy wyjątek od konwencji "brak współdzielonych utili" w tym
 * projekcie (jak window.Bus/Events), bo tłumaczenia z definicji MUSZĄ być
 * spójne między plikami - ten sam klucz "menu.title" nie może znaczyć co
 * innego w ui.js niż w tutorial.js.
 *
 * Użycie w innych plikach: `I18n.t('menu.title')` albo z podstawieniem
 * zmiennych `I18n.t('shop.section.upgrades')`, `I18n.t('tutorial.step1',
 * { name: 'Plastik' })` (zamienia dosłowne "{name}" w stringu na wartość).
 *
 * Musi ładować się PRZED każdym plikiem, który woła I18n.t() - stąd zaraz
 * po eventbus.js w index.html (patrz komentarz "KOLEJNOŚĆ WAŻNA" tam).
 */

const I18N_STORAGE_KEY = 'ecomart_lang';
const I18N_DEFAULT_LANG = 'pl';

// Słownik z kluczami zgrupowanymi wg panelu/pliku (nazwa.podnazwa) - rośnie
// stopniowo w miarę migrowania kolejnych ekranów gry na I18n.t(), NIE jest
// tłumaczeniem 1:1 całego kodu na starcie. Brakujący klucz w 'en' spada z
// powrotem do 'pl' (patrz t() niżej) - nigdy nie pokazuje surowego klucza
// graczowi.
const I18N_STRINGS = {
  pl: {
    'common.show': 'Pokaż',
    'common.close': 'Zamknij',
    'common.on': 'Włącz',
    'common.off': 'Wyłącz',

    'nav.shop': 'Sklep',
    'nav.menu': 'Menu',
    'nav.ship': 'Statek',

    'settings.title': 'Menu',
    'settings.close': 'Zamknij menu',
    'settings.section.progress': 'Postęp',
    'settings.section.preferences': 'Preferencje',
    'settings.section.data': 'Dane',
    'settings.section.about': 'O grze',

    'settings.achievements.name': 'Osiągnięcia',
    'settings.achievements.desc': 'Zdobyte: {unlocked}/{total} — bonus zarobku: +{bonus}%',
    'settings.skins.name': 'Skiny',
    'settings.skins.desc': 'Odblokowane: {unlocked}/{total}',
    'settings.stats.name': 'Statystyki',
    'settings.stats.desc': 'Podsumowanie postępów w grze',
    'settings.leaderboard.name': 'Tablica wyników',
    'settings.leaderboard.desc': 'Twoje najlepsze przebiegi',

    'settings.sound.name': 'Dźwięk',
    'settings.sound.desc': 'Włącz lub wycisz efekty dźwiękowe gry',
    'settings.musicVolume.name': 'Głośność muzyki',
    'settings.musicVolume.desc': 'Podkład w tle, osobno od przełącznika Dźwięk',
    'settings.musicVolume.label': 'Głośność muzyki',

    'settings.language.name': 'Język',
    'settings.language.desc': 'Język interfejsu gry',
    'settings.language.pl': 'Polski',
    'settings.language.en': 'English',

    'settings.tutorial.name': 'Samouczek',
    'settings.tutorial.desc': 'Pokaż od nowa krótkie wprowadzenie do gry',
    'settings.export.button': 'Eksportuj',
    'settings.export.name': 'Eksportuj zapis',
    'settings.export.desc': 'Pobierz kopię zapasową postępu jako plik',
    'settings.export.error': 'Nie udało się przygotować zapisu do eksportu.',
    'settings.import.button': 'Importuj',
    'settings.import.name': 'Importuj zapis',
    'settings.import.desc': 'Wczytaj wcześniej wyeksportowany plik zapisu',
    'settings.import.confirm': 'Na pewno zaimportować zapis z pliku? NADPISZE bieżący postęp (pieniądze, ulepszenia, statek, Rdzenie) - ta operacja jest nieodwracalna.',
    'settings.import.invalid': 'Ten plik nie wygląda na poprawny zapis Eco Mart.',
    'settings.import.readError': 'Nie udało się odczytać pliku.',
    'settings.reset.button': 'Resetuj',
    'settings.reset.name': 'Reset postępu',
    'settings.reset.desc': 'Kasuje cały zapis i zaczyna grę od nowa - nieodwracalne',
    'settings.reset.confirm': 'Na pewno zresetować CAŁY postęp? Ta operacja jest nieodwracalna - stracisz pieniądze, ulepszenia, statek i Rdzenie.',
    'settings.about.version': 'Wersja {version}',

    'shop.title': 'Sklep',
    'shop.close': 'Zamknij sklep',
    'shop.section.upgrades': 'Ulepszenia',
    'shop.section.licenses': 'Licencje i sprzęt',
    'shop.section.machines': 'Maszyny',

    'panel.achievements.title': 'Osiągnięcia',
    'panel.achievements.close': 'Zamknij osiągnięcia',
    'panel.skins.title': 'Skiny',
    'panel.skins.close': 'Zamknij skiny',
    'panel.stats.title': 'Statystyki',
    'panel.stats.close': 'Zamknij statystyki',
    'panel.leaderboard.title': 'Tablica wyników',
    'panel.leaderboard.close': 'Zamknij tablicę wyników'
  },
  en: {
    'common.show': 'Show',
    'common.close': 'Close',
    'common.on': 'On',
    'common.off': 'Off',

    'nav.shop': 'Shop',
    'nav.menu': 'Menu',
    'nav.ship': 'Ship',

    'settings.title': 'Menu',
    'settings.close': 'Close menu',
    'settings.section.progress': 'Progress',
    'settings.section.preferences': 'Preferences',
    'settings.section.data': 'Data',
    'settings.section.about': 'About',

    'settings.achievements.name': 'Achievements',
    'settings.achievements.desc': 'Unlocked: {unlocked}/{total} — income bonus: +{bonus}%',
    'settings.skins.name': 'Skins',
    'settings.skins.desc': 'Unlocked: {unlocked}/{total}',
    'settings.stats.name': 'Stats',
    'settings.stats.desc': 'Summary of your progress',
    'settings.leaderboard.name': 'Leaderboard',
    'settings.leaderboard.desc': 'Your best runs',

    'settings.sound.name': 'Sound',
    'settings.sound.desc': 'Turn game sound effects on or off',
    'settings.musicVolume.name': 'Music volume',
    'settings.musicVolume.desc': 'Background music, separate from the Sound switch',
    'settings.musicVolume.label': 'Music volume',

    'settings.language.name': 'Language',
    'settings.language.desc': 'Game interface language',
    'settings.language.pl': 'Polski',
    'settings.language.en': 'English',

    'settings.tutorial.name': 'Tutorial',
    'settings.tutorial.desc': 'Show the short intro again',
    'settings.export.button': 'Export',
    'settings.export.name': 'Export save',
    'settings.export.desc': 'Download a backup of your progress as a file',
    'settings.export.error': 'Could not prepare the save for export.',
    'settings.import.button': 'Import',
    'settings.import.name': 'Import save',
    'settings.import.desc': 'Load a previously exported save file',
    'settings.import.confirm': 'Import save from this file? This will OVERWRITE your current progress (money, upgrades, ship, Cores) - this cannot be undone.',
    'settings.import.invalid': "This file doesn't look like a valid Eco Mart save.",
    'settings.import.readError': 'Could not read the file.',
    'settings.reset.button': 'Reset',
    'settings.reset.name': 'Reset progress',
    'settings.reset.desc': 'Wipes your save and starts the game over - cannot be undone',
    'settings.reset.confirm': 'Reset your ENTIRE progress? This cannot be undone - you will lose money, upgrades, ship progress and Cores.',
    'settings.about.version': 'Version {version}',

    'shop.title': 'Shop',
    'shop.close': 'Close shop',
    'shop.section.upgrades': 'Upgrades',
    'shop.section.licenses': 'Licenses & gear',
    'shop.section.machines': 'Machines',

    'panel.achievements.title': 'Achievements',
    'panel.achievements.close': 'Close achievements',
    'panel.skins.title': 'Skins',
    'panel.skins.close': 'Close skins',
    'panel.stats.title': 'Stats',
    'panel.stats.close': 'Close stats',
    'panel.leaderboard.title': 'Leaderboard',
    'panel.leaderboard.close': 'Close leaderboard'
  }
};

class I18nService {
  constructor() {
    this.lang = this._loadLang();
    // Zgodność z <html lang="pl"> w index.html - poprawne dla czytników
    // ekranu/tłumaczy przeglądarki, nie tylko kosmetyka.
    document.documentElement.lang = this.lang;
  }

  _loadLang() {
    try {
      const saved = localStorage.getItem(I18N_STORAGE_KEY);
      if (saved === 'pl' || saved === 'en') return saved;
    } catch (e) {
      // localStorage niedostępny (np. tryb prywatny) - zostajemy przy domyślnym.
    }
    return I18N_DEFAULT_LANG;
  }

  /**
   * Pełny reload po zmianie języka - ten sam wzorzec co import zapisu
   * (save.js/ui.js: importSaveJSON -> location.reload()). Dziesiątki
   * miejsc w grze budują teksty raz przy renderowaniu, a nie trzymają
   * żywego bindingu do języka - re-renderowanie wszystkiego ręcznie byłoby
   * dużo bardziej kruche niż jeden reload, który i tak trwa ułamek sekundy.
   */
  setLang(lang) {
    if (lang !== 'pl' && lang !== 'en') return;
    if (lang === this.lang) return;
    try {
      localStorage.setItem(I18N_STORAGE_KEY, lang);
    } catch (e) {
      // Brak zapisu = język wróci do domyślnego po restarcie - nie warto
      // blokować przełączenia w bieżącej sesji z tego powodu.
    }
    location.reload();
  }

  /**
   * @param {string} key
   * @param {Object<string,string|number>} [vars] - podstawienia "{nazwa}" w stringu
   */
  t(key, vars) {
    const dict = I18N_STRINGS[this.lang] || I18N_STRINGS[I18N_DEFAULT_LANG];
    let str = dict[key];
    if (str === undefined) str = I18N_STRINGS[I18N_DEFAULT_LANG][key];
    if (str === undefined) return key;
    if (vars) {
      Object.keys(vars).forEach((k) => {
        str = str.split('{' + k + '}').join(vars[k]);
      });
    }
    return str;
  }
}

window.I18n = new I18nService();
