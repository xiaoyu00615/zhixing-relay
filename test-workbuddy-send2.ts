const input =
document.querySelector(
'[contenteditable="true"][role="textbox"]'
);


input.focus();


const text="你好，这是 Zhixing Relay 测试";


input.innerHTML =
`<p>${text}</p>`;


input.dispatchEvent(
 new InputEvent(
  "input",
  {
    bubbles:true,
    inputType:"insertText",
    data:text
  }
 )
);