// Debug-only UI helpers (loading screen toggle, Easter egg)
// Module API
function init({ state }) {
  if (!state) return;

  window.loadingScreenTest = {
    show: () => {
      state.loadingScreen = document.getElementById('loading-screen');
      if (!state.loadingScreen) {
        const newLoadingScreen = document.createElement('div');
        newLoadingScreen.id = 'loading-screen';
        newLoadingScreen.innerHTML = `
          <div class="loading-content">
            <div class="logo-container">
              <img src="assets/title.png" alt="App Logo and Title" class="app-logo-title">
            </div>
          </div>
        `;
        document.body.appendChild(newLoadingScreen);
        newLoadingScreen.offsetHeight;
      } else {
        state.loadingScreen.style.display = 'flex';
        state.loadingScreen.style.opacity = '1';
      }
    },

    hide: () => {
      state.loadingScreen = document.getElementById('loading-screen');
      if (state.loadingScreen) {
        state.loadingScreen.style.opacity = '0';
        setTimeout(() => {
          state.loadingScreen.style.display = 'none';
        }, 1000);
      }
    },

    toggle: () => {
      state.loadingScreen = document.getElementById('loading-screen');
      if (
        state.loadingScreen &&
        (state.loadingScreen.style.display === 'none' || state.loadingScreen.style.opacity === '0')
      ) {
        window.loadingScreenTest.show();
      } else {
        window.loadingScreenTest.hide();
      }
    }
  };

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
      window.loadingScreenTest.toggle();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'F6') {
      const overlay = document.getElementById('secret-overlay');
      if (overlay) {
        overlay.style.display = overlay.style.display === 'none' ? 'flex' : 'none';
      }
    }
  });
}

module.exports = { init };
