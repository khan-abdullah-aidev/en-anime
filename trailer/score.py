"""The trailer's score, synthesised from nothing: felt piano, koto, string
pads, taiko, rain. It reads the cue sheet from index.html, so every hit
lands on the frame it belongs to.

    python trailer/score.py        -> trailer/out/score.wav (48 kHz, -15 LUFS)
"""

import json
import math
import re
import subprocess
import sys
from pathlib import Path

import numpy as np

SR = 48000
HERE = Path(__file__).parent
OUT = HERE / "out"
OUT.mkdir(exist_ok=True)

html = (HERE / "index.html").read_text(encoding="utf-8")
C = json.loads(re.search(r'<script id="cues" type="application/json">(.*?)</script>', html, re.S).group(1))
DUR = C["duration"]
N = int((DUR + 0.2) * SR)
BEAT = C["beat"]
rng = np.random.default_rng(7)


# ——— helpers ———

NOTE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def hz(name):
    m = re.fullmatch(r"([A-G])([#b]?)(-?\d)", name)
    semi = NOTE[m.group(1)] + {"#": 1, "b": -1, "": 0}[m.group(2)]
    midi = 12 * (int(m.group(3)) + 1) + semi
    return 440.0 * 2 ** ((midi - 69) / 12)


def db(x):
    return 10 ** (x / 20)


def tt(n):
    return np.arange(n) / SR


def fft_filter(x, gain_fn):
    n = len(x)
    size = 1 << (n - 1).bit_length()
    spec = np.fft.rfft(x, size)
    f = np.fft.rfftfreq(size, 1 / SR)
    return np.fft.irfft(spec * gain_fn(f), size)[:n]


def lowpass(x, fc, order=2):
    return fft_filter(x, lambda f: 1 / np.sqrt(1 + (f / fc) ** (2 * order)))


def highpass(x, fc, order=2):
    return fft_filter(x, lambda f: 1 / np.sqrt(1 + (fc / np.maximum(f, 1e-3)) ** (2 * order)))


def bandpass(x, lo, hi, order=2):
    return highpass(lowpass(x, hi, order), lo, order)


def stft_filter(x, gain_at, frame=2048, hop=512):
    """Filter whose response changes over time: gain_at(freqs, seconds)."""
    pad = np.concatenate([np.zeros(frame), x, np.zeros(frame)])
    win = np.hanning(frame)
    count = (len(pad) - frame) // hop
    idx = np.arange(frame)[None, :] + hop * np.arange(count)[:, None]
    frames = pad[idx] * win
    spec = np.fft.rfft(frames, axis=1)
    f = np.fft.rfftfreq(frame, 1 / SR)
    centres = (hop * np.arange(count) + frame / 2 - frame) / SR
    gains = np.stack([gain_at(f, c) for c in centres])
    out_frames = np.fft.irfft(spec * gains, axis=1) * win
    out = np.zeros(len(pad))
    norm = np.zeros(len(pad))
    np.add.at(out, idx, out_frames)
    np.add.at(norm, idx, np.broadcast_to(win**2, out_frames.shape))
    out /= np.maximum(norm, 1e-3)
    return out[frame:frame + len(x)]


def movavg(x, w):
    c = np.cumsum(np.concatenate([np.zeros(w // 2 + 1), x, np.zeros(w)]))
    return (c[w:w + len(x)] - c[:len(x)]) / w


def pink(n):
    w = rng.standard_normal(n)
    return fft_filter(w, lambda f: 1 / np.sqrt(np.maximum(f, 20)))


def smooth_env(n, attack, release, hold_end=None):
    t = tt(n)
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    a = 0.5 - 0.5 * np.cos(np.pi * a)
    end = n / SR
    r = np.clip((end - t) / max(release, 1e-4), 0, 1)
    r = 0.5 - 0.5 * np.cos(np.pi * r)
    return a * r


# ——— the mix ———

class Bus:
    def __init__(self):
        self.dry = np.zeros((2, N))
        self.send = np.zeros(N)

    def add(self, sig, at, gain_db=0.0, pan=0.0, send=0.25):
        start = int(round(at * SR))
        if start >= N:
            return
        g = db(gain_db)
        if sig.ndim == 1:
            sig = sig[: N - start]
            th = (pan + 1) * np.pi / 4
            self.dry[0, start:start + len(sig)] += sig * g * math.cos(th)
            self.dry[1, start:start + len(sig)] += sig * g * math.sin(th)
            self.send[start:start + len(sig)] += sig * g * send
        else:
            sig = sig[:, : N - start]
            self.dry[:, start:start + sig.shape[1]] += sig * g
            self.send[start:start + sig.shape[1]] += sig.mean(axis=0) * g * send


def make_ir(t60=3.4, bright_t60=1.0, pre=0.022, seed=3):
    r = np.random.default_rng(seed)
    n = int(t60 * 1.15 * SR)
    t = tt(n)
    chans = []
    for _ in range(2):
        w = r.standard_normal(n)
        low = lowpass(w, 1800, 1)
        high = w - low
        ir = low * np.exp(-6.9 * t / t60) + 0.55 * high * np.exp(-6.9 * t / bright_t60)
        ir *= 1 - np.exp(-t / 0.035)
        ir = np.concatenate([np.zeros(int(pre * SR)), ir])
        chans.append(ir / np.sqrt(np.sum(ir**2)))
    return chans


def convolve(x, ir):
    n = len(x) + len(ir) - 1
    size = 1 << (n - 1).bit_length()
    return np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)[: len(x)]


def render_bus(bus, ir, wet_db=-4.0):
    wet = np.stack([convolve(bus.send, ir[0]), convolve(bus.send, ir[1])]) * db(wet_db)
    return bus.dry + wet


# ——— instruments ———

def felt_piano(f, dur=5.0, vel=0.6):
    """A felted upright: soft hammer, two strings a hair apart, upper partials fading fast."""
    n = int(dur * SR)
    t = tt(n)
    out = np.zeros(n)
    B = 0.00038
    pitch = math.sqrt(f / 262)
    for k in range(1, 13):
        fk = f * k * math.sqrt(1 + B * k * k)
        if fk > 7000:
            break
        amp = (vel ** (0.4 * k)) / k**1.25
        decay = (0.32 + 0.55 * k**1.15) * (0.55 + 0.45 * pitch)
        for cents in (-0.7, 0.7):
            ph = rng.uniform(0, 2 * np.pi)
            out += 0.5 * amp * np.sin(2 * np.pi * fk * 2 ** (cents / 1200) * t + ph) * np.exp(-t * decay)
    hammer = lowpass(rng.standard_normal(n), 1400 + 1800 * vel) * np.exp(-t / 0.006) * 0.08 * vel
    out = (out + hammer) * (1 - np.exp(-t / 0.0035))
    out *= smooth_env(n, 0.001, 0.4)
    return out * vel / max(np.abs(out).max(), 1e-9)


def koto(f, dur=3.5, vel=0.7, bright=0.62, t60=2.4):
    """Karplus-Strong string, plucked near the bridge, with the koto's settle in pitch."""
    period = SR / f - 0.5
    ni = max(2, int(period))
    f0 = SR / (ni + 0.5)
    n = int(dur * SR)
    m = int(n * f / f0) + 4 * ni
    exc = rng.standard_normal(ni)
    exc = lowpass(np.concatenate([exc, np.zeros(ni)]), 1200 + 6000 * bright, 1)[:ni]
    exc = exc - np.roll(exc, max(1, int(ni * 0.14)))
    buf = np.zeros(m + 1)
    buf[1:ni + 1] = exc
    g = 10 ** (-3 / (t60 * f0))
    a = 0.5 + 0.35 * bright
    k = 1
    while k * ni < m:
        s = 1 + k * ni
        e = min(s + ni, m + 1)
        prev = buf[s - ni:e - ni]
        prev2 = buf[s - ni - 1:e - ni - 1]
        buf[s:e] = g * (a * prev + (1 - a) * prev2)
        k += 1
    y = buf[1:]
    # Retune to the exact pitch and add the small drop as the string settles.
    t = tt(n)
    cents = 18 * np.exp(-t / 0.05)
    rate = (f / f0) * 2 ** (cents / 1200)
    pos = np.cumsum(rate) - rate[0]
    out = np.interp(pos, np.arange(len(y)), y)
    body = np.sin(2 * np.pi * f * t) * np.exp(-t / 0.5) * 0.12
    out = lowpass(out + body * np.abs(out).max(), 8500, 1)
    out *= smooth_env(n, 0.001, 0.5)
    return out * vel / max(np.abs(out).max(), 1e-9)


def pad(notes, dur, attack=1.6, release=2.2, bright=2200, voices=5, detune=9, vel=1.0, width=0.75):
    """Strings and warm synth in one: detuned, band-limited saws, slowly breathing."""
    n = int(dur * SR)
    t = tt(n)
    out = np.zeros((2, n))
    for name in notes:
        f = hz(name) if isinstance(name, str) else name
        for v in range(voices):
            c = detune * (v - (voices - 1) / 2) / ((voices - 1) / 2)
            fv = f * 2 ** (c / 1200)
            sig = np.zeros(n)
            k = 1
            while fv * k < min(bright * 2.2, 9000) and k < 48:
                amp = (1 / k) / math.sqrt(1 + (fv * k / bright) ** 4)
                sig += amp * np.sin(2 * np.pi * fv * k * t + rng.uniform(0, 2 * np.pi))
                k += 1
            lfo = 1 + 0.08 * np.sin(2 * np.pi * (0.13 + 0.05 * v) * t + v)
            pan = ((v / (voices - 1)) * 2 - 1) * width
            th = (pan + 1) * np.pi / 4
            out[0] += sig * lfo * math.cos(th)
            out[1] += sig * lfo * math.sin(th)
    out *= smooth_env(n, attack, release)
    # Clear the mud: a dip around 250 Hz and nothing below 45 Hz.
    shape = lambda f: (1 - 0.55 * np.exp(-((np.log2(np.maximum(f, 1) / 260)) ** 2) / 0.5)) / np.sqrt(1 + (45 / np.maximum(f, 1)) ** 4)
    out = np.stack([fft_filter(out[0], shape), fft_filter(out[1], shape)])
    peak = np.abs(out).max()
    return out * vel / max(peak, 1e-9) * 0.9


def boom(dur=3.5, f_hi=78, f_lo=33, vel=1.0):
    n = int(dur * SR)
    t = tt(n)
    f = f_lo + (f_hi - f_lo) * np.exp(-t / 0.11)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.95)
    thump = lowpass(rng.standard_normal(n), 220, 2) * np.exp(-t / 0.05) * 0.9
    click = bandpass(rng.standard_normal(n), 900, 4000) * np.exp(-t / 0.004) * 0.15
    out = body + thump + click
    out *= 1 - np.exp(-t / 0.002)
    return out * vel / np.abs(out).max()


def taiko(vel=1.0, size=1.0):
    n = int(1.6 * SR)
    t = tt(n)
    f = 58 / size + 55 / size * np.exp(-t / 0.028)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / (0.32 * size))
    skin = bandpass(rng.standard_normal(n), 140, 1100) * np.exp(-t / 0.045) * 0.55
    out = (body + skin) * (1 - np.exp(-t / 0.0015))
    return out * vel / np.abs(out).max()


def bell(f, dur=6.0, vel=0.5):
    n = int(dur * SR)
    t = tt(n)
    out = np.zeros(n)
    for ratio, amp, dec in [(1, 1, 0.6), (2.0, 0.5, 1.1), (2.76, 0.35, 1.6), (4.07, 0.22, 2.4), (5.4, 0.12, 3.2), (0.5, 0.25, 0.5)]:
        out += amp * np.sin(2 * np.pi * f * ratio * t + rng.uniform(0, 6)) * np.exp(-t * dec)
    out *= 1 - np.exp(-t / 0.002)
    return out * vel / np.abs(out).max()


def tick(vel=1.0, tone=3200):
    n = int(0.03 * SR)
    t = tt(n)
    w = bandpass(rng.standard_normal(n), tone * 0.6, tone * 1.6)
    out = w * np.exp(-t / 0.0011) + 0.4 * np.sin(2 * np.pi * 210 * t) * np.exp(-t / 0.006)
    return out * vel / np.abs(out).max()


def key_tap(vel=1.0):
    n = int(0.08 * SR)
    t = tt(n)
    thock = np.sin(2 * np.pi * (170 + 90 * np.exp(-t / 0.004)) * t) * np.exp(-t / 0.014)
    clack = bandpass(rng.standard_normal(n), 1800, 6500) * np.exp(-t / 0.0025) * 0.6
    out = thock + clack
    return out * vel / np.abs(out).max()


def swish(dur=0.45, vel=1.0):
    n = int(dur * SR)
    t = tt(n)
    w = rng.standard_normal(n)
    out = stft_filter(w, lambda f, c: np.exp(-((np.log(np.maximum(f, 20)) - np.log(1500 + 5000 * max(0.0, min(1.0, c / dur)))) ** 2) / 0.35))
    out *= np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 2
    return out * vel / np.abs(out).max()


def swell(dur, vel=1.0, lo=200, hi=9000):
    """Reverse-cymbal rise that ends exactly at its own end."""
    n = int(dur * SR)
    t = tt(n)
    w = rng.standard_normal(n)
    out = stft_filter(w, lambda f, c: 1 / (1 + (f / (lo + (hi - lo) * max(0.0, min(1.0, c / dur)) ** 2)) ** 4))
    out *= (t / dur) ** 3.2
    out *= smooth_env(n, 0.001, 0.012)
    return out * vel / np.abs(out).max()


def riser(dur, f_start, f_end, vel=1.0):
    n = int(dur * SR)
    t = tt(n)
    k = t / dur
    f = f_start * (f_end / f_start) ** (k**1.6)
    ph = 2 * np.pi * np.cumsum(f) / SR
    trem = 1 - 0.35 * (0.5 + 0.5 * np.sin(2 * np.pi * (3 + 18 * k**2) * t))
    out = (np.sin(ph) + 0.35 * np.sin(2 * ph) + 0.2 * np.sin(3 * ph * 1.003)) * trem * k**2.2
    return out * vel / np.abs(out).max()


def heart(vel=1.0):
    n = int(0.7 * SR)
    t = tt(n)
    one = np.sin(2 * np.pi * 52 * t) * np.exp(-t / 0.07)
    two = np.zeros(n)
    d = int(0.2 * SR)
    two[d:] = 0.65 * np.sin(2 * np.pi * 47 * t[: n - d]) * np.exp(-t[: n - d] / 0.08)
    out = (one + two) * (1 - np.exp(-t / 0.004))
    return out * vel / np.abs(out).max()


def rain(dur, vel=1.0):
    n = int(dur * SR)
    bed = bandpass(pink(n), 500, 7000, 1)
    bed /= np.abs(bed).max()
    drops = np.zeros(n)
    for _ in range(int(dur * 38)):
        at = rng.integers(0, n - 2000)
        L = int(SR * rng.uniform(0.004, 0.012))
        tl = tt(L)
        fdrop = rng.uniform(2200, 6000)
        drops[at:at + L] += np.sin(2 * np.pi * fdrop * tl * (1 + 0.6 * tl / tl[-1])) * np.exp(-tl / (L / SR / 4)) * rng.uniform(0.2, 1)
    out = 0.8 * bed + 0.25 * drops
    out *= smooth_env(n, 1.0, 1.4)
    return out * vel / np.abs(out).max()


# ——— the score ———

main = Bus()
act1 = Bus()
S = C["seal"]
R = C["reveal"]


def strum(bus, notes, at, gain_db, spread=0.028, pan=0.0, send=0.35, **kw):
    for i, name in enumerate(notes):
        bus.add(koto(hz(name), **kw), at + i * spread, gain_db - 1.5 * i, pan + 0.12 * (i - len(notes) / 2), send)


# Act one: 11:47 PM, the scroll.
act1.add(pad(["D2", "A2", "D3"], C["cut"] + 0.6, attack=3.0, release=0.5, bright=520, vel=1), 0.2, -27, send=0.3)
act1.add(pad(["A3", "Bb3", "E4"], C["cut"] - 5.0, attack=2.6, release=0.3, bright=1600, detune=16, vel=1), 5.3, -32, send=0.4)
act1.add(bandpass(pink(int(C["cut"] * SR)), 200, 3000, 1) / 3, 0.0, -44, send=0.0)
for at, name, vel in [(0.6, "D3", 0.45), (0.62, "A3", 0.4), (2.7, "F4", 0.5), (3.45, "E4", 0.42), (4.2, "D4", 0.4), (5.3, "Bb3", 0.45), (5.32, "D4", 0.4), (6.1, "A3", 0.45)]:
    act1.add(felt_piano(hz(name), 4.5, vel), at, -11, pan=-0.1 if name < "E" else 0.12, send=0.5)
# The scroll wheel: slow notches, then the rush.
tick_times = []
x = 1.6
while x < C["cut"]:
    tick_times.append(x)
    rate = 2.6 + 3.5 * (x - 1.6) / (C["rush"] - 1.6) if x < C["rush"] else 6 * (1 + 46 * 2 ** (10 * ((x - C["rush"]) / (C["cut"] - C["rush"])) - 10))
    x += max(0.012, rng.exponential(1 / rate) * 0.6 + 0.4 / rate)
for x in tick_times:
    k = max(0.0, (x - C["rush"]) / (C["cut"] - C["rush"]))
    act1.add(tick(rng.uniform(0.5, 1), tone=rng.uniform(2600, 4200)), x, -27 + 13 * k, pan=rng.uniform(-0.6, 0.6), send=0.15)
rush = C["cut"] - C["rush"]
act1.add(riser(rush, hz("D3"), hz("D6")), C["rush"], -8, send=0.3)
act1.add(swell(rush, lo=150, hi=12000), C["rush"], -5, send=0.2)
act1.add(swell(1.4, lo=300, hi=14000), C["cut"] - 1.4, -7, send=0.1)
act1.add(boom(1.2, f_hi=50, f_lo=30, vel=1) [::-1].copy() * np.linspace(0, 1, int(1.2 * SR)) ** 2, C["cut"] - 1.2, -12, send=0.0)

# Act two: silence, then a single string.
main.add(lowpass(pink(int(3 * SR)), 900, 1) / 4 * smooth_env(int(3 * SR), 1.0, 0.5), C["cut"], -48, send=0)
main.add(koto(hz("A4"), 5, 0.8, bright=0.5, t60=3.5), C["dot"], -9, send=0.7)
main.add(pad(["D3", "A3", "E4", "F4"], S - 11.6 + 0.6, attack=2.4, release=0.6, bright=1100, vel=1), 11.6, -24, send=0.5)
for at, name, vel in [(C["q1"], "D4", 0.45), (C["q1"] + 0.02, "A3", 0.4), (C["q2"], "F4", 0.5), (C["q2"] + 0.02, "C4", 0.4), (C["q2"] + 0.75, "E4", 0.42)]:
    main.add(felt_piano(hz(name), 4.5, vel), at, -10, pan=0.08, send=0.5)
main.add(swell(1.3, lo=200, hi=9000), S - 1.3, -12, send=0.3)

# The seal.
main.add(boom(4, vel=1), S, -4, send=0.25)
main.add(taiko(1, 1.1), S, -8, send=0.35)
main.add(bell(hz("D5"), 6, 1), S, -21, pan=-0.2, send=0.6)
main.add(bell(hz("A5"), 6, 1), S + 0.01, -23, pan=0.2, send=0.6)
strum(main, ["D3", "A3", "D4", "E4", "A4"], S, -11, bright=0.6)

# Act three: reads, listens, considers. Pads on a two-bar grid.
bar = 4 * BEAT
chords = [
    (S, ["D2", "A2", "D3", "F3", "A3", "C4", "E4"], 2200),
    (S + 2 * bar, ["Bb1", "F2", "Bb2", "D3", "F3", "A3", "E4"], 2000),
    (S + 4 * bar, ["G1", "D2", "G2", "Bb2", "D3", "F3", "A3"], 1700),
]
for i, (at, notes, br) in enumerate(chords):
    length = (chords[i + 1][0] if i + 1 < len(chords) else C["think"]) - at + 1.0
    main.add(pad(notes, length, attack=1.2 if i else 0.4, release=1.3, bright=br), at, -15, send=0.35)
main.add(pad(["A1", "E2", "A2", "D3", "E3"], C["breath"] - C["think"] + 0.1, attack=1.0, release=0.12, bright=900), C["think"] - 0.4, -17, send=0.3)
main.add(pad(["E5", "A5"], C["breath"] - 29.6, attack=2.0, release=0.12, bright=5000, detune=14, voices=4), 29.6, -31, send=0.6)

ost_a = ["D4", "A4", "E5", "A4", "F5", "A4", "E5", "A4"]
ost_b = ["D4", "A4", "F5", "A4", "E5", "A4", "D5", "A4"]
x = C["reads"]
i = 0
while x < C["think"] - 0.2:
    pattern = ost_b if x >= S + 4 * bar else ost_a
    name = pattern[i % 8]
    quiet = C["mood"] <= x < C["think"]
    accent = 0 if i % 2 == 0 else -4
    if not (quiet and i % 2):
        main.add(koto(hz(name), 2.2, 0.7, bright=0.55, t60=1.6), x, -15 + accent - (5 if quiet else 0), pan=0.3 if i % 2 else -0.3, send=0.3)
    x += BEAT / 2
    i += 1
x = C["reads"]
while x < C["think"]:
    main.add(heart(0.6), x, -22, send=0.05)
    x += BEAT
for at, name in [(C["reads"], "A4"), (C["reads"] + 1.4, "E5"), (C["reads"] + 2.8, "D5"), (C["reads"] + 4.2, "C5"), (C["reads"] + 4.9, "A4")]:
    main.add(felt_piano(hz(name), 4, 0.55), at, -9, pan=0.1, send=0.45)
# Pins and strikes as the list is read.
loves = [0, 1, 3, 6, 8, 9, 11]
drops = [2, 5]
pent = ["A5", "C6", "D6", "E6", "G6", "A6", "C7"]
for j, row in enumerate(loves):
    main.add(bell(hz(pent[j]), 2.5, 1), C["readRows"] + row * 0.27, -28, pan=0.35, send=0.5)
for row in drops:
    main.add(swish(0.4), C["readRows"] + row * 0.27, -27, pan=0.35, send=0.2)
# Typing.
t_type = C["type"]
for i, ch in enumerate(C["typeText"]):
    d = 0.062 + 0.022 * math.sin(i * 12.9898) * math.sin(i * 4.1414)
    main.add(key_tap(rng.uniform(0.6, 1)), t_type, -21 if ch != " " else -24, pan=rng.uniform(-0.15, 0.15), send=0.08)
    if ch == " ":
        d += 0.03
    if ch in ".,":
        d += 0.32
    t_type += d
main.add(key_tap(1), C["press"], -16, send=0.2)
main.add(koto(hz("D6"), 3, 0.5, bright=0.3, t60=2.5), C["press"] + 0.02, -18, send=0.6)
# Considering: four soft steps down, then the held breath.
for at, name in zip(C["thinkLines"], ["A4", "G4", "F4", "E4"]):
    main.add(felt_piano(hz(name), 3.5, 0.45), at, -12, send=0.55)
x = C["think"]
while x < C["breath"]:
    main.add(heart(0.8), x, -17, send=0.05)
    x += BEAT
main.add(riser(C["breath"] - 30.4, hz("A3"), hz("A5"), 1), 30.4, -22, send=0.4)
main.add(swell(C["breath"] - 30.6, lo=200, hi=8000), 30.6, -17, send=0.2)
main.add(swell(R - C["breath"] - 0.15, lo=300, hi=12000), C["breath"] + 0.15, -14, send=0.2)

# The reveal: the answer, in D major.
main.add(boom(4.5, vel=1), R, -3, send=0.3)
main.add(taiko(1, 1.15), R, -7, send=0.35)
for name, p in [("D5", -0.25), ("A5", 0.25), ("F#6", 0)]:
    main.add(bell(hz(name), 7, 1), R, -20, pan=p, send=0.7)
strum(main, ["D3", "A3", "D4", "F#4", "A4", "D5"], R, -10, bright=0.65)
main.add(pad(["D2", "A2", "D3", "F#3", "A3", "C#4", "E4"], 3.4, attack=0.25, release=1.2, bright=2600), R, -13, send=0.35)
main.add(pad(["B1", "F#2", "B2", "D3", "F#3", "A3", "C#4"], C["one"] - (R + 2.8) + 0.6, attack=1.0, release=0.9, bright=2400), R + 2.8, -14, send=0.35)
main.add(rain(C["one"] - R + 1.5, 1), R - 0.2, -27, send=0.1)
theme = [(1, "A4"), (1.5, "D5"), (2, "E5"), (3, "F#5"), (5, "E5"), (5.5, "D5"), (6, "B4"), (7, "A4")]
for b, name in theme:
    main.add(felt_piano(hz(name), 5, 0.62), R + b * BEAT, -6, pan=0.06, send=0.5)
for b in range(1, 15):
    name = ["D4", "A4", "E5", "F#5", "A4", "E5", "D5", "A4"][b % 8]
    main.add(koto(hz(name), 2, 0.6, bright=0.5, t60=1.5), R + b * BEAT / 2 + BEAT / 2, -19, pan=0.35 if b % 2 else -0.35, send=0.35)
# One anime. Not a list.
main.add(pad(["G2", "D3", "F#3", "B3"], C["two"] - C["one"] + 0.3, attack=0.8, release=1.0, bright=1100), C["one"] - 0.2, -25, send=0.5)
main.add(felt_piano(hz("D3"), 5, 0.5), C["one"], -13, send=0.5)
main.add(felt_piano(hz("A3"), 5, 0.45), C["one"] + 0.02, -14, send=0.5)
main.add(felt_piano(hz("D5"), 5, 0.45), C["one"] + 0.04, -14, send=0.6)
main.add(bell(hz("F#5"), 5, 1), C["never"], -24, send=0.7)
main.add(felt_piano(hz("A4"), 4, 0.45), C["never"] + 0.7, -11, send=0.5)
main.add(swell(1.1, lo=300, hi=10000), C["two"] - 1.1, -14, send=0.2)

# Where it helps: drums arrive.
cards = [C["two"], C["torn"], C["resume"], C["learn"]]
card_chords = [
    ["G1", "D2", "G2", "B2", "D3", "F#3", "A3"],
    ["A1", "E2", "A2", "C#3", "E3", "F#3", "B3"],
    ["B1", "F#2", "B2", "D3", "F#3", "A3", "C#4"],
    ["G1", "D2", "G2", "B2", "D3", "F#3", "A3"],
]
for k, (at, notes) in enumerate(zip(cards, card_chords)):
    main.add(pad(notes, bar + 0.6, attack=0.3, release=0.5, bright=2200 + 500 * k), at, -14, send=0.35)
    main.add(taiko(1, 1.0), at, -8, send=0.3)
    main.add(taiko(0.5, 0.8), at + 2.5 * BEAT, -17, pan=-0.2, send=0.3)
    main.add(taiko(0.6, 0.85), at + 3 * BEAT, -15, pan=0.2, send=0.3)
    main.add(boom(2, f_hi=60, f_lo=36, vel=1), at, -14, send=0.1)
main.add(pad(["A1", "E2", "A2", "C#3", "E3"], 1.6, attack=0.4, release=0.6, bright=2600), C["learn"] + 2 * BEAT, -16, send=0.35)
ost_m = ["D5", "A4", "B4", "A4", "E5", "A4", "F#5", "A4"]
x = C["two"]
i = 0
while x < C["finale"] - 0.1:
    main.add(koto(hz(ost_m[i % 8]), 1.6, 0.6, bright=0.6, t60=1.2), x, -17 if i % 2 else -14, pan=0.35 if i % 2 else -0.35, send=0.28)
    main.add(tick(0.6, 5200), x + BEAT / 4, -33, pan=0.4, send=0.1)
    x += BEAT / 2
    i += 1
for at, name in [(C["two"], "B4"), (C["two"] + 2 * BEAT, "D5"), (C["torn"], "C#5"), (C["torn"] + 2 * BEAT, "E5"),
                 (C["resume"], "D5"), (C["resume"] + 2 * BEAT, "F#5"), (C["learn"], "B4"), (C["learn"] + 2 * BEAT, "A4")]:
    main.add(felt_piano(hz(name), 3.5, 0.6), at, -8, pan=0.05, send=0.45)
# For two: one note from each side, meeting as the pick appears.
main.add(koto(hz("D5"), 3, 0.7), C["two"] + 1.5, -12, pan=-0.85, send=0.5)
main.add(koto(hz("D5"), 3, 0.7), C["two"] + 1.5, -12, pan=0.85, send=0.5)
main.add(bell(hz("A5"), 4, 1), C["two"] + 1.5, -24, send=0.6)
# Torn: two strikes, one winner.
decide = C["torn"] + 1.2
main.add(swish(0.4), decide, -22, pan=-0.5, send=0.2)
main.add(swish(0.4), decide + 0.12, -22, pan=0.5, send=0.2)
main.add(bell(hz("F#5"), 4, 1), decide + 0.2, -22, send=0.6)
# Resume: the bar fills, a run climbs with it.
for j, name in enumerate(["B4", "C#5", "D5", "E5", "F#5", "A5", "B5"]):
    main.add(koto(hz(name), 2, 0.55, bright=0.7, t60=1.4), C["resume"] + 0.9 + j * 0.15, -17, pan=-0.4 + 0.12 * j, send=0.35)
# Learns: a bell for every pick that landed.
streak = [1, 0, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]
up = ["A5", "B5", "D6", "E6", "F#6", "A6", "B6", "D7"]
j = 0
for k, hit in enumerate(streak):
    at = C["learn"] + 0.95 + k * 0.075
    if hit:
        main.add(bell(hz(up[min(j, 7)]), 1.8, 1), at, -27, pan=-0.5 + k / 14, send=0.4)
        j += 1
    else:
        main.add(tick(0.5, 1800), at, -30, pan=-0.5 + k / 14, send=0.1)
main.add(key_tap(0.8), C["learn"] + 0.8, -18, send=0.2)

# 縁: the thread, then everything.
F, K = C["finale"], C["kanji"]
n = int((K - F + 0.2) * SR)
t = tt(n)
vib = 1 + 0.004 * np.sin(2 * np.pi * 5.2 * t) * np.clip(t / 1.5, 0, 1)
ph = 2 * np.pi * np.cumsum(hz("A5") * vib) / SR
thread = (np.sin(ph) + 0.18 * np.sin(2 * ph) + 0.06 * np.sin(3 * ph)) * smooth_env(n, 2.2, 0.15) * np.clip(t / (K - F), 0, 1) ** 0.6
main.add(thread, F, -25, send=0.6)
main.add(pad(["A1", "E2", "A2", "D3", "E3"], K - F + 0.1, attack=2.0, release=0.1, bright=900), F, -19, send=0.4)
main.add(swell(1.6, lo=200, hi=12000), K - 1.6, -11, send=0.25)
main.add(boom(5, f_hi=72, f_lo=30, vel=1), K, -2, send=0.3)
main.add(taiko(1, 1.2), K, -6, send=0.4)
for name, p in [("D5", -0.3), ("F#5", 0.3), ("A5", -0.1), ("D6", 0.1)]:
    main.add(bell(hz(name), 7, 1), K, -20, pan=p, send=0.75)
strum(main, ["D3", "A3", "D4", "F#4", "A4", "D5"], K, -9, bright=0.7, spread=0.035)
main.add(pad(["D1", "D2", "A2", "D3", "F#3", "A3", "C#4", "E4", "F#4"], C["stop"] - K + 0.2, attack=0.2, release=1.6, bright=3000), K, -11, send=0.4)
for at, name in [(K + 0.7, "A5"), (K + 1.45, "F#5"), (K + 2.1, "E5")]:
    main.add(felt_piano(hz(name), 4, 0.5), at, -10, send=0.5)
# Stop scrolling. Tonight, let En choose.
main.add(felt_piano(hz("D3"), 5, 0.55), C["stop"], -14, send=0.5)
main.add(felt_piano(hz("A3"), 5, 0.45), C["stop"] + 0.03, -15, send=0.5)
main.add(felt_piano(hz("F#4"), 5, 0.45), C["stop"] + 0.05, -14, send=0.6)
main.add(pad(["G2", "D3", "B3", "E4"], C["end"] - C["stop"] + 0.3, attack=1.2, release=0.6, bright=1200), C["stop"], -28, send=0.5)
main.add(felt_piano(hz("A4"), 4, 0.5), C["tonight"], -9, send=0.5)
main.add(felt_piano(hz("D5"), 4, 0.5), C["tonight"] + 2 * BEAT, -9, send=0.5)
main.add(swell(0.9, lo=300, hi=9000), C["end"] - 0.9, -18, send=0.3)
# The end card: home.
E = C["end"]
main.add(boom(4, f_hi=60, f_lo=32, vel=1), E, -9, send=0.3)
main.add(pad(["D2", "A2", "E3", "F#3", "A3", "C#4", "E4"], DUR - E, attack=0.3, release=DUR - C["fade"], bright=2400), E, -12, send=0.45)
for name, v in [("D3", 0.55), ("A3", 0.5), ("E4", 0.45), ("F#4", 0.5)]:
    main.add(felt_piano(hz(name), 6, v), E, -12 if name < "E" else -9, send=0.55)
main.add(koto(hz("D5"), 5, 0.75, t60=3.2), E, -10, send=0.6)
main.add(bell(hz("A5"), 7, 1), E, -21, send=0.7)
main.add(koto(hz("A5"), 5, 0.5, bright=0.45, t60=3.2), E + 2 * BEAT, -15, send=0.7)
main.add(felt_piano(hz("F#5"), 5, 0.45), E + 4 * BEAT, -12, send=0.6)


# ——— mixdown ———

print("reverb…", flush=True)
hall = make_ir(3.8, 1.8)
room = make_ir(1.8, 0.7, seed=9)
a1 = render_bus(act1, room, -5)
# The cut is a cut: act one stops dead, tail and all.
cut = int(C["cut"] * SR)
gate = np.ones(N)
gate[cut:] = 0
ramp = int(0.004 * SR)
gate[cut - ramp:cut] = np.linspace(1, 0, ramp)
a1 *= gate
mix = render_bus(main, hall, -3) + a1

# Gentle glue: a slow compressor on the sum, then a soft ceiling.
mono = np.abs(mix).max(axis=0)
win = int(0.03 * SR)
envl = np.sqrt(np.maximum(movavg(mono**2, win), 0))
thr = np.percentile(envl[envl > 1e-4], 99) * 0.75
gain = np.where(envl > thr, (thr / np.maximum(envl, 1e-9)) ** 0.25, 1.0)
gain = movavg(gain, int(0.08 * SR))
mix *= gain
air = lambda f: 1 + 0.9 * (1 / (1 + (5500 / np.maximum(f, 1)) ** 2)) - 0.2 * np.exp(-((np.log2(np.maximum(f, 1) / 300)) ** 2) / 0.6)
mix = np.stack([fft_filter(mix[0], air), fft_filter(mix[1], air)])
mix /= np.abs(mix).max()
mix = np.tanh(mix * 1.6) / np.tanh(1.6)
fade = int(0.25 * SR)
mix[:, -fade:] *= np.linspace(1, 0, fade)
mix *= db(-1.5)


def write_wav(path, data):
    data = np.clip(data.T, -1, 1).astype("<f4")
    with open(path, "wb") as fh:
        nbytes = data.nbytes
        fh.write(b"RIFF" + (36 + nbytes).to_bytes(4, "little") + b"WAVE")
        fh.write(b"fmt " + (16).to_bytes(4, "little") + (3).to_bytes(2, "little") + (2).to_bytes(2, "little"))
        fh.write(SR.to_bytes(4, "little") + (SR * 8).to_bytes(4, "little") + (8).to_bytes(2, "little") + (32).to_bytes(2, "little"))
        fh.write(b"data" + nbytes.to_bytes(4, "little") + data.tobytes())


raw = OUT / "score-raw.wav"
write_wav(raw, mix)

# Loudness: measure, then one fixed gain to -15 LUFS with -1 dB true peak.
print("loudness…", flush=True)
probe = subprocess.run(
    ["ffmpeg", "-hide_banner", "-i", str(raw), "-af", "loudnorm=I=-15:TP=-1:LRA=18:print_format=json", "-f", "null", "-"],
    capture_output=True, text=True,
)
stats = json.loads(probe.stderr[probe.stderr.rindex("{"):probe.stderr.rindex("}") + 1])
print("measured", stats["input_i"], "LUFS, peak", stats["input_tp"], flush=True)
lift = -15 - float(stats["input_i"])
peak_room = -1 - float(stats["input_tp"])
gain_db = min(lift, peak_room)
if lift > peak_room:
    print(f"held to {gain_db:.1f} dB by the peak ceiling", flush=True)
subprocess.run(
    ["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw), "-af", f"volume={gain_db:.2f}dB", "-c:a", "pcm_f32le", str(OUT / "score.wav")],
    check=True,
)
print(OUT / "score.wav")
