import React, { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Building2, Loader2 } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BuildingService } from "@/services/api";
import { toast } from "sonner";

export default function CreateBuildingModal({ isOpen, onClose, properties = [] }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({
    name: "",
    property_id: properties[0]?.id || "",
    address: "",
    total_sf: "",
    floors: "1",
    year_built: "",
  });

  const createMutation = useMutation({
    mutationFn: (data) => BuildingService.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["bu-buildings"] });
      toast.success("Building created successfully.");
      onClose();
      setForm({ name: "", property_id: properties[0]?.id || "", address: "", total_sf: "", floors: "1", year_built: "" });
    },
    onError: (err) => {
      toast.error(`Failed to create building: ${err.message}`);
    },
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.name || !form.property_id) return;
    createMutation.mutate({
      ...form,
      total_sf: parseInt(form.total_sf) || 0,
      floors: parseInt(form.floors) || 1,
      year_built: parseInt(form.year_built) || null,
      status: "active",
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(v) => { if(!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="w-5 h-5 text-purple-600" />
            Add New Building
          </DialogTitle>
          <DialogDescription>
            Create a new building structure within an existing property.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="name">Building Name *</Label>
            <Input 
              id="name" 
              placeholder="e.g. Building A" 
              value={form.name} 
              onChange={e => setForm({...form, name: e.target.value})} 
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="property">Property *</Label>
            <Select 
              value={form.property_id} 
              onValueChange={v => setForm({...form, property_id: v})}
            >
              <SelectTrigger id="property">
                <SelectValue placeholder="Select property..." />
              </SelectTrigger>
              <SelectContent>
                {properties.map(p => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="address">Address (Optional)</Label>
            <Input 
              id="address" 
              placeholder="If different from property address" 
              value={form.address} 
              onChange={e => setForm({...form, address: e.target.value})} 
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="total_sf">Total SQ FT</Label>
              <Input 
                id="total_sf" 
                type="number" 
                placeholder="0" 
                value={form.total_sf} 
                onChange={e => setForm({...form, total_sf: e.target.value})} 
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="floors">Floors</Label>
              <Input 
                id="floors" 
                type="number" 
                min="1" 
                value={form.floors} 
                onChange={e => setForm({...form, floors: e.target.value})} 
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="year_built">Year Built</Label>
            <Input 
              id="year_built" 
              type="number" 
              placeholder="e.g. 2020" 
              value={form.year_built} 
              onChange={e => setForm({...form, year_built: e.target.value})} 
            />
          </div>

          <DialogFooter className="pt-4 flex !justify-between items-center sm:!justify-between">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button 
              type="submit" 
              className="bg-purple-600 hover:bg-purple-700 min-w-[120px]" 
              disabled={!form.name || !form.property_id || createMutation.isPending}
            >
              {createMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              Create Building
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
