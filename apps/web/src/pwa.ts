export type ServiceWorkerUpdateState =
  | { status: "unsupported" }
  | { status: "disabled" }
  | { status: "registered" }
  | { status: "update-available"; applyUpdate: () => void }
  | { status: "error"; error: Error };

export type ServiceWorkerRegistrationOptions = {
  onUpdateAvailable?: (applyUpdate: () => void) => void;
  onRegistered?: (registration: ServiceWorkerRegistration) => void;
  onError?: (error: Error) => void;
};

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const PWA_UPDATE_EVENT = "dibao:pwa-update-available";

export function registerServiceWorker(
  options: ServiceWorkerRegistrationOptions = {}
): void {
  if (!import.meta.env.PROD) {
    return;
  }

  if (!("serviceWorker" in navigator)) {
    return;
  }

  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((registration) => {
        options.onRegistered?.(registration);
        if (registration.waiting && navigator.serviceWorker.controller) {
          notifyUpdateAvailable(
            createApplyUpdate(registration, registration.waiting),
            options
          );
        }
        registration.addEventListener("updatefound", () => {
          const installingWorker = registration.installing;
          if (!installingWorker) {
            return;
          }

          installingWorker.addEventListener("statechange", () => {
            if (installingWorker.state === "installed" && navigator.serviceWorker.controller) {
              const applyUpdate = createApplyUpdate(registration, installingWorker);
              notifyUpdateAvailable(applyUpdate, options);
            }
          });
        });

        window.setInterval(() => {
          void registration.update().catch((error: unknown) => {
            options.onError?.(toError(error));
          });
        }, UPDATE_CHECK_INTERVAL_MS);
      })
      .catch((error: unknown) => {
        options.onError?.(toError(error));
      });
  });
}

function createApplyUpdate(
  registration: ServiceWorkerRegistration,
  candidateWorker: ServiceWorker
): () => void {
  let hasReloaded = false;

  return () => {
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hasReloaded) {
        return;
      }

      hasReloaded = true;
      window.location.reload();
    });

    const waitingWorker = registration.waiting ?? candidateWorker;
    waitingWorker.postMessage({ type: "SKIP_WAITING" });
  };
}

function notifyUpdateAvailable(
  applyUpdate: () => void,
  options: ServiceWorkerRegistrationOptions
): void {
  options.onUpdateAvailable?.(applyUpdate);
  window.dispatchEvent(
    new CustomEvent(PWA_UPDATE_EVENT, {
      detail: { applyUpdate }
    })
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
