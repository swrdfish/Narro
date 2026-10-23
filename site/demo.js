// The hero demo: highlights the sample article sentence by sentence, like Narro does.
const demo = document.querySelector('.demo');
const sentences = [...demo.querySelectorAll('.s')];
const counter = demo.querySelector('.count .now');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let index = 0;
let timer = null;

function show(i) {
  index = i;
  sentences.forEach((sentence, n) => sentence.classList.toggle('speaking', n === i));
  for (const para of demo.querySelectorAll('.demo-para')) para.classList.toggle('reading', para.contains(sentences[i]));
  counter.textContent = String(i + 1);
}

// Roughly how long the sentence would take to say.
const duration = (sentence) => Math.max(1600, sentence.textContent.length * 55);

function next() {
  show((index + 1) % sentences.length);
  timer = setTimeout(next, duration(sentences[index]));
}

// Respect reduced motion: a still frame, shown paused.
if (reducedMotion.matches) {
  show(1);
  demo.classList.add('paused');
} else {
  show(0);
  timer = setTimeout(next, duration(sentences[index]));
}
