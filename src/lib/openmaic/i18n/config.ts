import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import resourcesToBackend from 'i18next-resources-to-backend';
import { supportedLocales } from './locales';
import { defaultLocale } from './types';
import arSA from './locales/ar-SA.json';
import enUS from './locales/en-US.json';
import jaJP from './locales/ja-JP.json';
import koKR from './locales/ko-KR.json';
import ptBR from './locales/pt-BR.json';
import ruRU from './locales/ru-RU.json';
import zhCN from './locales/zh-CN.json';
import zhTW from './locales/zh-TW.json';

const localeResources = {
  'ar-SA': arSA,
  'en-US': enUS,
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'pt-BR': ptBR,
  'ru-RU': ruRU,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
} as const;

type LocaleResourceKey = keyof typeof localeResources;

function loadLocaleResource(language: string) {
  return Promise.resolve(
    localeResources[language as LocaleResourceKey] ?? localeResources[defaultLocale],
  );
}

i18n
  .use(initReactI18next)
  .use(resourcesToBackend(loadLocaleResource))
  .init({
    lng: defaultLocale,
    fallbackLng: defaultLocale,
    supportedLngs: supportedLocales.map((l) => l.code),
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;
