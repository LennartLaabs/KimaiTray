//! ADVERSUM: the local language model, as a program of its own.
//!
//! `kimaitray-llm <model.gguf>` loads the model with llama.cpp (on the GPU
//! where Metal is available), prints `{"ready":true}` and then answers one
//! request per line on standard input with one line on standard output:
//!
//! ```text
//! → {"instructions":"…","input":"…","grammar":"root ::= …","maxTokens":700}
//! ← {"ok":true,"text":"{…}","ms":1840,"tokens":96,"read":41}
//! ← {"ok":false,"error":"…"}
//! ```
//!
//! The answer is forced into the grammar (GBNF), so it is always the JSON
//! the app expects. Nothing is sampled at random: the same sentence gives
//! the same answer. The program ends when its input closes; the app closes
//! it ten minutes after the last request to free the memory.

use std::io::{BufRead, Write};
use std::num::NonZeroU32;
use std::time::Instant;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::token::LlamaToken;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{LlamaChatMessage, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use serde::{Deserialize, Serialize};

/// Room for the instructions, the names of the catalog and the answer.
const CONTEXT_TOKENS: u32 = 4096;
const DEFAULT_MAX_TOKENS: usize = 700;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    instructions: String,
    input: String,
    grammar: String,
    max_tokens: Option<usize>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Reply {
    Text {
        ok: bool,
        text: String,
        ms: u128,
        /// Tokens written, and tokens of the request that had to be read anew.
        tokens: usize,
        read: usize,
    },
    Error {
        ok: bool,
        error: String,
    },
}

/// The context and what it has read so far. Requests share a long opening
/// (the instructions and examples), which is read once and kept.
struct Session<'a> {
    context: LlamaContext<'a>,
    read: Vec<LlamaToken>,
}

fn answer(model: &LlamaModel, session: &mut Session, request: &Request) -> Result<Reply, String> {
    let started = Instant::now();
    // One user turn carries everything: not every model has a system role.
    let content = format!("{}\n\n{}", request.instructions, request.input);
    let message = LlamaChatMessage::new("user".into(), content).map_err(|e| e.to_string())?;
    let template = model.chat_template(None).map_err(|e| e.to_string())?;
    let prompt = model
        .apply_chat_template(&template, &[message], true)
        .map_err(|e| e.to_string())?;
    let vocab = model.vocab();
    let tokens = vocab.tokenize(prompt.as_bytes(), true, true);
    let limit = request.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS);
    if tokens.is_empty() || tokens.len() + limit > CONTEXT_TOKENS as usize {
        return Err(format!("the request is too long ({} tokens)", tokens.len()));
    }

    // Keep what this request has in common with the last one; at least the
    // final token is read again, so there is something to sample from.
    let shared = session
        .read
        .iter()
        .zip(&tokens)
        .take_while(|(old, new)| old == new)
        .count()
        .min(tokens.len() - 1);
    session
        .context
        .clear_kv_cache_seq(Some(0), Some(shared as u32), None)
        .map_err(|e| e.to_string())?;
    session.read.clear();
    let mut batch = LlamaBatch::new(CONTEXT_TOKENS as usize, 1);
    let last = tokens.len() - 1;
    for (position, token) in tokens.iter().enumerate().skip(shared) {
        batch
            .add(*token, position as i32, &[0], position == last)
            .map_err(|e| e.to_string())?;
    }
    session.context.decode(&mut batch).map_err(|e| e.to_string())?;
    session.read.extend_from_slice(&tokens);

    let grammar =
        LlamaSampler::grammar(model, &request.grammar, "root").map_err(|e| e.to_string())?;
    let mut sampler = LlamaSampler::chain_simple([grammar, LlamaSampler::greedy()]);
    let mut bytes: Vec<u8> = Vec::new();
    let mut position = tokens.len() as i32;
    let mut produced = 0;
    while produced < limit {
        // `sample` also tells the grammar which token was taken.
        let token = sampler.sample(&session.context, batch.n_tokens() - 1);
        if vocab.is_eog(token) {
            break;
        }
        bytes.extend(vocab.token_to_piece(token, false, None));
        produced += 1;
        batch.clear();
        batch
            .add(token, position, &[0], true)
            .map_err(|e| e.to_string())?;
        position += 1;
        session.context.decode(&mut batch).map_err(|e| e.to_string())?;
    }
    Ok(Reply::Text {
        ok: true,
        text: String::from_utf8_lossy(&bytes).into_owned(),
        ms: started.elapsed().as_millis(),
        tokens: produced,
        read: tokens.len() - shared,
    })
}

fn say(reply: &impl Serialize) {
    let mut out = std::io::stdout().lock();
    let _ = serde_json::to_writer(&mut out, reply);
    let _ = out.write_all(b"\n");
    let _ = out.flush();
}

fn main() {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: kimaitray-llm <model.gguf>");
        std::process::exit(64);
    };
    let mut backend = match LlamaBackend::init() {
        Ok(backend) => backend,
        Err(error) => {
            say(&Reply::Error { ok: false, error: error.to_string() });
            std::process::exit(1);
        }
    };
    // llama.cpp is chatty; what matters comes back as a reply.
    backend.void_logs();
    let gpu = backend.supports_gpu_offload();
    let params = LlamaModelParams::default().with_n_gpu_layers(if gpu { 1000 } else { 0 });
    let model = match LlamaModel::load_from_file(&backend, &path, &params) {
        Ok(model) => model,
        Err(error) => {
            say(&Reply::Error { ok: false, error: error.to_string() });
            std::process::exit(1);
        }
    };
    let context_params = LlamaContextParams::default()
        .with_n_ctx(NonZeroU32::new(CONTEXT_TOKENS))
        .with_n_batch(CONTEXT_TOKENS);
    let context = match model.new_context(&backend, context_params) {
        Ok(context) => context,
        Err(error) => {
            say(&Reply::Error { ok: false, error: error.to_string() });
            std::process::exit(1);
        }
    };
    let mut session = Session { context, read: Vec::new() };
    say(&serde_json::json!({ "ready": true, "gpu": gpu }));

    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Request>(&line) {
            Ok(request) => answer(&model, &mut session, &request)
                .unwrap_or_else(|error| Reply::Error { ok: false, error }),
            Err(error) => Reply::Error { ok: false, error: format!("bad request: {error}") },
        };
        say(&reply);
    }
}
