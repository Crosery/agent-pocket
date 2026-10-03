# Render a mel spectrogram + percussive onset strength as a PNG to "see" the arrangement.
import sys, numpy as np, librosa, matplotlib
matplotlib.use('Agg'); import matplotlib.pyplot as plt
for path in sys.argv[1:]:
    y, sr = librosa.load(path, sr=22050, mono=True)
    H, P = librosa.effects.hpss(y)
    M = librosa.power_to_db(librosa.feature.melspectrogram(y=y, sr=sr, n_mels=128, hop_length=256), ref=np.max)
    on = librosa.onset.onset_strength(y=P, sr=sr, hop_length=256)
    t = librosa.times_like(on, sr=sr, hop_length=256)
    fig, ax = plt.subplots(2, 1, figsize=(24, 7), sharex=True, gridspec_kw={'height_ratios': [3, 1]})
    ax[0].imshow(M, origin='lower', aspect='auto', extent=[0, len(y)/sr, 0, 128], cmap='magma', vmin=-70, vmax=0)
    ax[1].plot(t, on, lw=0.6)
    for a in ax:
        a.set_xticks(np.arange(0, len(y)/sr, 2)); a.grid(axis='x', alpha=0.4)
    ax[0].set_title(path.split('/')[-1])
    plt.tight_layout(); out = path.rsplit('.', 1)[0] + '_spec.png'; plt.savefig(out, dpi=60); print(out)
