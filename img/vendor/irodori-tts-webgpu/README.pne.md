# P.N.E. vendored Irodori-TTS WebGPU runtime

This directory contains the browser inference core and tokenizer files used by
the P.N.E. name-voice prototype.

- Runtime source: `ngc-shj/irodori-tts-webgpu`
- Pinned runtime revision: `aa3b6390018bb09a2e461c95d1f55992c06e197d`
- Runtime license: MIT (`LICENSE`)
- ONNX Runtime Web: `1.23.0` (MIT; vendored JS + matching Asyncify WebGPU Wasm)
- Transformers.js: `3.7.6` (Apache-2.0; vendored browser bundle)
- Tokenizer: `llm-jp/llm-jp-3-150m` (Apache-2.0)
- Remote ONNX source: `noguchis/irodori-tts-onnx`
- Pinned ONNX revision: `b75a9bbf2c10e12682d37e91e0efaf6d4e54bd29`

The pinned fp16 ONNX model files are redistributed in
`models/<revision>/onnx_fp16/` as part of the P.N.E. desktop bundle. The browser
loads these local static assets on first use; it does not download the model or
copy it into Cache Storage. The model bundle is approximately 1.17 GiB
(1,255,474,038 bytes). All executable browser runtime files are vendored here;
text, reference audio, and generated audio are not included in model requests.
Synthesis runs inside the browser via WebGPU.

See `LICENSES/NOTICE` and the other files in `LICENSES/` for upstream notices
and the documented ONNX/fp16 conversion modifications.

Before public distribution, have the `facebook/dacvae-watermarked` lineage
terms reviewed against the current upstream model cards; the inherited model
metadata is not fully consistent about those base terms.
