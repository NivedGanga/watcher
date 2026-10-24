import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import {
  enablePushInThisBrowser,
  pushSupport,
  thisBrowserDevice,
  type PushSupport,
  type RegistrationResult,
} from '../lib/push';

export function BrowserCard() {
  const { getIdToken } = useAuth();
  const [support] = useState<PushSupport>(() => pushSupport());
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [permission, setPermission] = useState<string>(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    thisBrowserDevice()
      .then((c) => setDeviceId(c ? c.device_id : null))
      .catch(() => setDeviceId(null));
  }, []);

  const enable = async () => {
    setBusy(true);
    setError(null);
    const result: RegistrationResult = await enablePushInThisBrowser(getIdToken);
    setBusy(false);
    if (result.status === 'registered') {
      setDeviceId(result.deviceId);
      setPermission('granted');
    } else if (result.status === 'permission-denied') {
      setPermission('denied');
    } else if (result.status === 'error') {
      setError(result.message);
    }
  };

  let body;
  if (support === 'unsupported') {
    body = (
      <p>
        Push alerts aren&apos;t supported in this browser. Use a browser with service worker and
        push support — for example Chrome on Android or desktop.
      </p>
    );
  } else if (support === 'ios-standalone-required') {
    body = (
      <p>
        On iPhone and iPad, push alerts require the app to be installed: open AgentWatch in Safari,
        tap Share, then <strong>Add to Home Screen</strong>, and open it from the home screen.
      </p>
    );
  } else if (permission === 'denied') {
    body = (
      <div>
        <p>
          <strong>Alerts will not appear in this browser.</strong>
        </p>
        <p>
          Notifications are blocked. To re-enable them: open this browser&apos;s site settings for
          this page (for example, the lock/tune icon in the address bar), set Notifications to
          Allow, then reload.
        </p>
      </div>
    );
  } else if (deviceId) {
    body = <p>This browser is registered for alerts. Push is active here.</p>;
  } else {
    body = (
      <div>
        <p>Get push alerts in this browser, even when the tab is closed.</p>
        <button onClick={enable} disabled={busy}>
          {busy ? 'Turning on…' : 'Turn on alerts in this browser'}
        </button>
      </div>
    );
  }

  return (
    <section className="card" aria-label="This browser">
      <h2>This browser</h2>
      {body}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
