const empty=()=>({text:'',materials:[],moments:[],focus:null});
const key=(kind,ref)=>kind==='materials'?JSON.stringify([ref.id,ref.page,ref.quote]):ref.id;

// One draft owns both text and references. A send receipt addresses the exact
// edits that were sent; later edits and remove/re-add gestures survive it.
export class ConversationDraft {
  constructor(value){this.value=structuredClone(value||empty());this.textVersion=0;}
  get hasContent(){return Boolean(this.value.text||this.value.materials.length||this.value.moments.length);}
  text(value){if(value===this.value.text)return false;this.value.text=value;this.textVersion++;return true;}
  references(kind,refs){
    const existing=this.value[kind];
    this.value[kind]=refs.map(ref=>({...ref,token:existing.find(r=>key(kind,r)===key(kind,ref))?.token||crypto.randomUUID()}));
  }
  snapshot(){return structuredClone({draft:this.value,textVersion:this.textVersion});}
  acknowledge(snapshot){
    if(this.textVersion===snapshot.textVersion)this.text('');
    for(const kind of ['materials','moments']) {
      const sent=new Set(snapshot.draft[kind].map(r=>r.token));
      this.value[kind]=this.value[kind].filter(r=>!sent.has(r.token));
    }
    if(!this.hasContent)this.value.focus=null;
  }
}
