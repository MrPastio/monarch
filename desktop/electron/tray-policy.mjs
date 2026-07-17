export function shouldHideToTrayOnClose({ smokeMode, shuttingDown, quitRequested }) {
  return !smokeMode && !shuttingDown && !quitRequested;
}

export function trayWindowLabel(isVisible) {
  return isVisible ? 'Скрыть Monarch' : 'Открыть Monarch';
}
