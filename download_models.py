from huggingface_hub import snapshot_download
import urllib.request
import os
import pathlib

os.makedirs('libs/pdfjs', exist_ok=True)
for url, path in [
    ('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.6.172/pdf.min.js', 'libs/pdfjs/pdf.min.js'),
    ('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.6.172/pdf.worker.min.js', 'libs/pdfjs/pdf.worker.min.js')
]:
    print('Downloading', url)
    urllib.request.urlretrieve(url, path)
    print('Saved', path)

models = {
    'MonkeyOCRv2': 'zenosai/MonkeyOCRv2-B',
}
os.makedirs('hf_models', exist_ok=True)
for name, repo_id in models.items():
    print(f'Downloading {name} from {repo_id}')
    outdir = snapshot_download(
        repo_id,
        cache_dir='hf_models',
        local_dir=os.path.join('hf_models', pathlib.Path(repo_id).name),
        local_dir_use_symlinks=False,
        force_download=True
    )
    print('Downloaded', outdir)
