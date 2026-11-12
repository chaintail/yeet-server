// Consent page: keep the submit button disabled until every required box is ticked. The server checks again.
for(const form of document.querySelectorAll('form[data-yeet-agreements]')){
 const button=form.querySelector('button[type=submit]');
 const boxes=[...form.querySelectorAll('input[type=checkbox][required]')];
 const sync=()=>{button.disabled=!boxes.every(b=>b.checked)};
 form.addEventListener('change',sync);
 sync();
}
