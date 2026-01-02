def chunk_text(text, max_words=800):
  words = text.split()
  chunks = []
  current_chunk = []
  current_count = 0

  for word in words:
      current_chunk.append(word)
      current_count += 1
      if current_count >= max_words:
          chunks.append(" ".join(current_chunk))
          current_chunk = []
          current_count = 0

  if current_chunk:
      chunks.append(" ".join(current_chunk))

  return chunks
    