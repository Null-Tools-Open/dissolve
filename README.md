# Dissolve

**Ultra-fast, multi-threaded file compression tool for images, videos, and media files**


## What is Dissolve?

Ever wondered how Null Drop can store so many files without overloading our servers?
Dissolve is the answer. Both Null Drop and other Null Applications use Dissolve to quickly and safely reduce media file sizes. From megabytes down to kilobytes in seconds.

Dissolve can reduce file sizes by around 68% while keeping the same format.
When using efficient formats like AVIF or JPEG, reductions can reach 86%, and in some cases, even up to 97%.


## How it works

When you upload a file, whether through the public API or one of our apps, Dissolve automatically processes it.
It attempts to reduce the file size while preserving 100% visual quality.
If compression doesn’t achieve a smaller result, the original file is kept untouched.

To achieve these reductions, Dissolve removes unnecessary metadata and optimizes internal file structure.
After compression, nulldrop re-injects essential metadata such as ownership, timestamps, and security data to ensure full compatibility.

## Why do I see the original size?

You may notice that we still display the original size of your file.

This is intentional, the original size helps maintain transparency and consistency across clients and APIs.

Additionally, some reduced files are stored internally in their optimized form, while the system references the original metadata for display and analytics purposes.

In short: we show you what you uploaded, even if what we store is smaller.

### Todo

- Rewrite in TypeScript (DONE!)
- Rewrite core in Rust for better performance and native efficiency