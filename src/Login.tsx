import { useState } from 'react';
import { api, ApiFailure } from './api';
import { Banner, Button, TextField } from './ui';

export function LoginForm({ onSignedIn, intro }: { onSignedIn: (username: string) => void; intro?: string }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (!username || !password) return setError('Enter your username and password.');
    setBusy(true);
    setError('');
    try {
      const res = await api.login(username, password);
      setPassword('');
      onSignedIn(res.username);
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : 'Sign-in failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="adm-login__form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {intro && <p className="adm-muted">{intro}</p>}
      {error && <Banner kind="error">{error}</Banner>}
      <TextField label="Username" value={username} onChange={setUsername} required />
      <TextField label="Password" type="password" value={password} onChange={setPassword} required />
      <Button type="submit" variant="primary" busy={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}

export function LoginScreen({ onSignedIn }: { onSignedIn: (username: string) => void }) {
  return (
    <div className="adm-login">
      <div className="adm-login__card">
        <h1>Portfolio Admin</h1>
        <LoginForm onSignedIn={onSignedIn} />
      </div>
    </div>
  );
}
